use fast_image_resize::images::{Image, ImageRef, TypedImage, TypedImageRef};
use fast_image_resize::pixels::F32;
use fast_image_resize::{PixelType, Resizer};
use image::{DynamicImage, GrayImage, RgbImage};
use ndarray::Array4;

use crate::error::AppError;
use crate::models::ModelEntry;

fn resize_error(e: impl std::fmt::Display) -> AppError {
    AppError::Pipeline(format!("resize failed: {e}"))
}

/// Lanczos3 resize of a packed u8 buffer via SIMD convolution (`fast_image_resize`).
/// Same filter as `image::imageops::FilterType::Lanczos3`, roughly an order of
/// magnitude faster on multi-megapixel inputs.
fn resize_lanczos3(
    src: &[u8],
    src_size: (u32, u32),
    dst_size: (u32, u32),
    pixel_type: PixelType,
) -> Result<Vec<u8>, AppError> {
    if src_size == dst_size {
        return Ok(src.to_vec());
    }
    let src_image = ImageRef::new(src_size.0, src_size.1, src, pixel_type).map_err(resize_error)?;
    let mut dst_image = Image::new(dst_size.0, dst_size.1, pixel_type);
    // Default options = Convolution(Lanczos3); U8 / U8x3 have no alpha to premultiply.
    Resizer::new()
        .resize(&src_image, &mut dst_image, None)
        .map_err(resize_error)?;
    Ok(dst_image.into_vec())
}

pub fn preprocess(model: &ModelEntry, image: &DynamicImage) -> Result<Array4<f32>, AppError> {
    match image {
        DynamicImage::ImageRgb8(rgb) => preprocess_rgb(model, rgb),
        other => preprocess_rgb(model, &other.to_rgb8()),
    }
}

/// Resize to the model input and normalize into an NCHW `[1, 3, size, size]` tensor.
pub fn preprocess_rgb(model: &ModelEntry, rgb: &RgbImage) -> Result<Array4<f32>, AppError> {
    let size = model.input_size;
    let resized = resize_lanczos3(
        rgb.as_raw(),
        rgb.dimensions(),
        (size, size),
        PixelType::U8x3,
    )?;

    // (v / 255 - mean) / std  ==  v * scale + bias, hoisted per channel.
    let mut scale = [0f32; 3];
    let mut bias = [0f32; 3];
    for c in 0..3 {
        let mean = model.mean.get(c).copied().unwrap_or(0.0);
        let std = model.std.get(c).copied().unwrap_or(1.0);
        scale[c] = 1.0 / (255.0 * std);
        bias[c] = -mean / std;
    }

    let plane = size as usize * size as usize;
    let mut data = vec![0f32; 3 * plane];
    let (r, gb) = data.split_at_mut(plane);
    let (g, b) = gb.split_at_mut(plane);
    for (i, px) in resized.as_chunks::<3>().0.iter().enumerate() {
        r[i] = px[0] as f32 * scale[0] + bias[0];
        g[i] = px[1] as f32 * scale[1] + bias[1];
        b[i] = px[2] as f32 * scale[2] + bias[2];
    }
    Array4::from_shape_vec([1, 3, size as usize, size as usize], data)
        .map_err(|e| AppError::Pipeline(format!("tensor shape: {e}")))
}

pub fn postprocess(
    model: &ModelEntry,
    original_size: (u32, u32),
    output: &ndarray::ArrayD<f32>,
) -> Result<GrayImage, AppError> {
    let (h, w, logits) = extract_logits(output)?;
    let mask = match model.postprocess {
        crate::models::PostprocessKind::MinMax => quantize_minmax(&logits, |v| v),
        // BiRefNet logits: sigmoid then min-max (raw min-max on unbounded logits is washed).
        crate::models::PostprocessKind::SigmoidMinMax => quantize_minmax(&logits, sigmoid),
    };
    resize_feather(original_size, (w as u32, h as u32), mask)
}

fn sigmoid(v: f32) -> f32 {
    1.0 / (1.0 + (-v).exp())
}

/// Map `f(values)` onto 0..=255 with a min-max stretch, in one allocation.
fn quantize_minmax(values: &[f32], f: impl Fn(f32) -> f32) -> Vec<u8> {
    let (min, max) = values
        .iter()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &v| {
            (lo.min(v), hi.max(v))
        });
    // `f` is monotonic non-decreasing (identity / sigmoid), so the stretch bounds
    // are just `f` of the raw bounds — no second pass over transformed values.
    let (min, max) = (f(min), f(max));
    let range = max - min;
    if range == 0.0 || !range.is_finite() {
        return vec![0; values.len()];
    }
    let k = 255.0 / range;
    values
        .iter()
        .map(|&v| ((f(v) - min) * k).round() as u8)
        .collect()
}

fn resize_feather(
    original_size: (u32, u32),
    mask_size: (u32, u32),
    mask: Vec<u8>,
) -> Result<GrayImage, AppError> {
    // f32 like `image::imageops::resize`: a u8 resize clamps and rounds between the
    // two Lanczos passes, which moves hard mask edges by up to ~40 alpha levels.
    let resized = {
        let src: Vec<F32> = mask.iter().map(|&v| F32::new(v as f32)).collect();
        let src = TypedImageRef::new(mask_size.0, mask_size.1, &src).map_err(resize_error)?;
        let mut dst = TypedImage::<F32>::new(original_size.0, original_size.1);
        Resizer::new()
            .resize_typed(&src, &mut dst, None)
            .map_err(resize_error)?;
        // Collected into u8 here so the f32 buffers are freed before the blur.
        dst.pixels()
            .iter()
            .map(|p| p.0.round().clamp(0.0, 255.0) as u8)
            .collect()
    };
    let resized = GrayImage::from_raw(original_size.0, original_size.1, resized)
        .ok_or_else(|| AppError::Pipeline("resized mask buffer size mismatch".into()))?;
    // Light Gaussian feathering on the mask edges keeps hair/fur borders from looking
    // pixelated and hard after resizing back to the original resolution.
    Ok(image::imageops::blur(&resized, 1.0))
}

/// Borrow the `[1, 1, h, w]` logits as a flat row-major slice (copy only if the
/// tensor is not in standard layout, which ORT outputs always are).
fn extract_logits(
    output: &ndarray::ArrayD<f32>,
) -> Result<(usize, usize, std::borrow::Cow<'_, [f32]>), AppError> {
    let shape = output.shape();
    if shape.len() != 4 || shape[0] != 1 || shape[1] != 1 {
        return Err(AppError::Pipeline(format!(
            "unexpected output shape {:?}",
            shape
        )));
    }
    let (h, w) = (shape[2], shape[3]);
    let logits = match output.as_slice() {
        Some(slice) => std::borrow::Cow::Borrowed(slice),
        None => std::borrow::Cow::Owned(output.iter().copied().collect()),
    };
    Ok((h, w, logits))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::find_model;

    #[test]
    fn preprocess_shape_and_red_channel_value() {
        let u2netp = find_model("u2netp").unwrap();
        let img =
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(64, 64, image::Rgb([255, 0, 0])));
        let tensor = preprocess(u2netp, &img).unwrap();
        assert_eq!(tensor.shape(), &[1, 3, 320, 320]);
        let red = tensor[[0, 0, 10, 10]];
        assert!((red - (1.0 - 0.485) / 0.229).abs() < 1e-5);
    }

    #[test]
    fn preprocess_isnet_uses_half_range_normalization() {
        let isnet = find_model("isnet-general-use").unwrap();
        let img =
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(64, 64, image::Rgb([255, 0, 0])));
        let tensor = preprocess(isnet, &img).unwrap();
        assert_eq!(tensor.shape(), &[1, 3, 1024, 1024]);
        let red = tensor[[0, 0, 10, 10]];
        // (255/255 - 0.5) / 1.0 = 0.5
        assert!((red - 0.5).abs() < 1e-5);
    }

    #[test]
    fn preprocess_birefnet_general_lite_is_512_imagenet() {
        // High mode: 512² + ImageNet mean/std (studioludens/birefnet-lite-512).
        let biref = find_model("birefnet-general-lite").unwrap();
        let img =
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(64, 64, image::Rgb([255, 0, 0])));
        let tensor = preprocess(biref, &img).unwrap();
        assert_eq!(tensor.shape(), &[1, 3, 512, 512]);
        let red = tensor[[0, 0, 10, 10]];
        assert!((red - (1.0 - 0.485) / 0.229).abs() < 1e-5);
    }

    #[test]
    fn postprocess_u2netp_min_max_normalization() {
        let mut data = Vec::with_capacity(64 * 64);
        for y in 0..64 {
            for x in 0..64 {
                let nx = x as f32 / 63.0;
                let ny = y as f32 / 63.0;
                data.push(nx + ny - 1.0);
            }
        }
        let output =
            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 64, 64]), data).unwrap();
        let mask = postprocess(find_model("u2netp").unwrap(), (64, 64), &output).unwrap();
        assert_eq!(mask.dimensions(), (64, 64));
        let min_pixel = mask.pixels().map(|p| p[0]).min().unwrap();
        let max_pixel = mask.pixels().map(|p| p[0]).max().unwrap();
        // Edge feathering prevents the absolute extremes from being exactly 0/255.
        assert!(min_pixel < 10);
        assert!(max_pixel > 245);
        let mid = mask.get_pixel(31, 31)[0];
        assert!((mid as i16 - 128).abs() <= 8);
    }

    #[test]
    fn postprocess_uniform_tensor_returns_zeros() {
        let output =
            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 2, 2]), vec![0.5f32; 4])
                .unwrap();
        let mask = postprocess(find_model("u2netp").unwrap(), (2, 2), &output).unwrap();
        assert_eq!(mask.dimensions(), (2, 2));
        for y in 0..2 {
            for x in 0..2 {
                assert_eq!(mask.get_pixel(x, y)[0], 0);
            }
        }
    }

    #[test]
    fn postprocess_rmbg_uses_minmax() {
        // Raw model outputs are stretched to the full [0, 255] range and lightly feathered.
        let mut data = Vec::with_capacity(16 * 16);
        for _y in 0..16 {
            for x in 0..16 {
                let v = if x < 8 { 10.0f32 } else { -10.0f32 };
                data.push(v);
            }
        }
        let output =
            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 16, 16]), data).unwrap();
        let mask = postprocess(find_model("rmbg-1.4").unwrap(), (16, 16), &output).unwrap();
        assert_eq!(mask.dimensions(), (16, 16));
        let min_pixel = mask.pixels().map(|p| p[0]).min().unwrap();
        let max_pixel = mask.pixels().map(|p| p[0]).max().unwrap();
        assert!(min_pixel < 10);
        assert!(max_pixel > 245);
        // Edge along x=8 should be softened by the feathering blur.
        let edge = mask.get_pixel(8, 8)[0];
        assert!(edge > 10 && edge < 245);
    }

    #[test]
    fn postprocess_isnet_uses_minmax() {
        // Balanced (isnet-general-use) should use min-max and edge feathering.
        let mut data = Vec::with_capacity(16 * 16);
        for _y in 0..16 {
            for x in 0..16 {
                let v = if x < 8 { 8.0f32 } else { -8.0f32 };
                data.push(v);
            }
        }
        let output =
            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 16, 16]), data).unwrap();
        let mask =
            postprocess(find_model("isnet-general-use").unwrap(), (16, 16), &output).unwrap();
        assert_eq!(mask.dimensions(), (16, 16));
        let min_pixel = mask.pixels().map(|p| p[0]).min().unwrap();
        let max_pixel = mask.pixels().map(|p| p[0]).max().unwrap();
        assert!(min_pixel < 10);
        assert!(max_pixel > 245);
        let edge = mask.get_pixel(8, 8)[0];
        assert!(edge > 10 && edge < 245);
    }

    #[test]
    fn postprocess_birefnet_general_lite_uses_sigmoid_minmax() {
        // High (birefnet-general-lite): sigmoid then min-max + feather (BiRefNet logits).
        // Large-magnitude logits must not wash out the way raw min-max does.
        let mut data = Vec::with_capacity(16 * 16);
        for _y in 0..16 {
            for x in 0..16 {
                // Unbalanced extremes: raw min-max puts the left half near ~0.16
                // after stretch; sigmoid saturates both sides to ~0/1 first.
                let v = if x < 8 { 20.0f32 } else { -4.0f32 };
                data.push(v);
            }
        }
        let output =
            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 16, 16]), data).unwrap();
        let mask = postprocess(
            find_model("birefnet-general-lite").unwrap(),
            (16, 16),
            &output,
        )
        .unwrap();
        assert_eq!(mask.dimensions(), (16, 16));
        let min_pixel = mask.pixels().map(|p| p[0]).min().unwrap();
        let max_pixel = mask.pixels().map(|p| p[0]).max().unwrap();
        assert!(min_pixel < 10);
        assert!(max_pixel > 245);
        // Interior of the positive half should stay near white after sigmoid saturation.
        let interior = mask.get_pixel(2, 8)[0];
        assert!(
            interior > 240,
            "expected saturated fg after sigmoid, got {interior}"
        );
        let edge = mask.get_pixel(8, 8)[0];
        assert!(edge > 10 && edge < 245);
    }

    #[test]
    fn every_registry_entry_has_postprocess() {
        let output =
            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 2, 2]), vec![0.1f32; 4])
                .unwrap();
        for model in crate::models::static_registry() {
            postprocess(model, (2, 2), &output)
                .unwrap_or_else(|e| panic!("{} postprocess failed: {e}", model.id));
        }
    }

    #[test]
    fn hard_mask_upscale_matches_image_crate_lanczos3() {
        // Binary diagonal mask: the worst case for intermediate rounding/clamping.
        let (src, dst) = ((320u32, 320u32), (1008u32, 756u32));
        let mask: Vec<u8> = (0..src.0 * src.1)
            .map(|i| if i % src.0 > i / src.0 { 255 } else { 0 })
            .collect();
        let gray = GrayImage::from_raw(src.0, src.1, mask.clone()).unwrap();
        let reference = image::imageops::blur(
            &image::imageops::resize(&gray, dst.0, dst.1, image::imageops::FilterType::Lanczos3),
            1.0,
        );
        let ours = resize_feather(dst, src, mask).unwrap();
        let max_diff = reference
            .pixels()
            .zip(ours.pixels())
            .map(|(a, b)| a[0].abs_diff(b[0]))
            .max()
            .unwrap();
        assert!(max_diff <= 2, "max diff {max_diff}");
    }
}
