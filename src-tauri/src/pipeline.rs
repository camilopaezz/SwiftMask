use image::{imageops::FilterType, DynamicImage, GrayImage};
use ndarray::{Array4, Axis};

use crate::error::AppError;
use crate::models::ModelEntry;

pub fn preprocess(model: &ModelEntry, image: &DynamicImage) -> Result<Array4<f32>, AppError> {
    let size = model.input_size;
    let resized = image.resize_exact(size, size, FilterType::Lanczos3);
    let rgb = resized.to_rgb8();
    let mut tensor = Array4::<f32>::zeros([1, 3, size as usize, size as usize]);
    for (x, y, pix) in rgb.enumerate_pixels() {
        for c in 0..3 {
            let v = pix[c] as f32 / 255.0;
            let mean = if model.mean.len() == 1 {
                model.mean[0]
            } else {
                model.mean.get(c).copied().unwrap_or(0.0)
            };
            let std = if model.std.len() == 1 {
                model.std[0]
            } else {
                model.std.get(c).copied().unwrap_or(1.0)
            };
            tensor[[0, c, y as usize, x as usize]] = (v - mean) / std;
        }
    }
    Ok(tensor)
}

pub fn postprocess(
    model_id: &str,
    original_size: (u32, u32),
    output: &ndarray::ArrayD<f32>,
) -> Result<GrayImage, AppError> {
    match model_id {
        "u2netp" | "isnet-general-use" | "rmbg-1.4" | "rmbg-2.0" => {
            postprocess_minmax(original_size, output)
        }
        // BiRefNet logits: sigmoid then min-max (raw min-max on unbounded logits is washed).
        "birefnet-general-lite" => postprocess_sigmoid_minmax(original_size, output),
        _ => Err(AppError::Pipeline(format!(
            "unknown postprocess model_id {}",
            model_id
        ))),
    }
}

fn postprocess_minmax(
    original_size: (u32, u32),
    output: &ndarray::ArrayD<f32>,
) -> Result<GrayImage, AppError> {
    let (h, w, logits) = extract_logits(output)?;
    normalize_resize_feather(original_size, h, w, &logits)
}

/// BiRefNet: apply sigmoid before min-max stretch.
fn postprocess_sigmoid_minmax(
    original_size: (u32, u32),
    output: &ndarray::ArrayD<f32>,
) -> Result<GrayImage, AppError> {
    let (h, w, logits) = extract_logits(output)?;
    let probs: Vec<f32> = logits
        .iter()
        .map(|&v| 1.0 / (1.0 + (-v).exp()))
        .collect();
    normalize_resize_feather(original_size, h, w, &probs)
}

fn normalize_resize_feather(
    original_size: (u32, u32),
    h: usize,
    w: usize,
    values: &[f32],
) -> Result<GrayImage, AppError> {
    let min = values.iter().copied().fold(f32::INFINITY, f32::min);
    let max = values.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let range = max - min;
    let mut mask = GrayImage::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let v = values[y * w + x];
            let n = if range == 0.0 { 0.0 } else { (v - min) / range };
            let p = (n * 255.0).round() as u8;
            mask.put_pixel(x as u32, y as u32, image::Luma([p]));
        }
    }
    let resized =
        image::imageops::resize(&mask, original_size.0, original_size.1, FilterType::Lanczos3);
    // Light Gaussian feathering on the mask edges keeps hair/fur borders from looking
    // pixelated and hard after resizing back to the original resolution.
    let feathered = image::imageops::blur(&resized, 1.0);
    Ok(feathered)
}

fn extract_logits(output: &ndarray::ArrayD<f32>) -> Result<(usize, usize, Vec<f32>), AppError> {
    let shape = output.shape();
    if shape.len() != 4 || shape[0] != 1 || shape[1] != 1 {
        return Err(AppError::Pipeline(format!(
            "unexpected output shape {:?}",
            shape
        )));
    }
    let h = shape[2];
    let w = shape[3];
    let logits: Vec<f32> = output
        .index_axis(Axis(0), 0)
        .index_axis(Axis(0), 0)
        .iter()
        .copied()
        .collect();
    Ok((h, w, logits))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::find_model;

    #[test]
    fn preprocess_shape_and_red_channel_value() {
        let u2netp = find_model("u2netp").unwrap();
        let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            64,
            64,
            image::Rgb([255, 0, 0]),
        ));
        let tensor = preprocess(u2netp, &img).unwrap();
        assert_eq!(tensor.shape(), &[1, 3, 320, 320]);
        let red = tensor[[0, 0, 10, 10]];
        assert!((red - (1.0 - 0.485) / 0.229).abs() < 1e-5);
    }

    #[test]
    fn preprocess_isnet_uses_half_range_normalization() {
        let isnet = find_model("isnet-general-use").unwrap();
        let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            64,
            64,
            image::Rgb([255, 0, 0]),
        ));
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
        let img = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            64,
            64,
            image::Rgb([255, 0, 0]),
        ));
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
        let output = ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 64, 64]), data).unwrap();
        let mask = postprocess("u2netp", (64, 64), &output).unwrap();
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
        let output = ndarray::ArrayD::from_shape_vec(
            ndarray::IxDyn(&[1, 1, 2, 2]),
            vec![0.5f32; 4],
        )
        .unwrap();
        let mask = postprocess("u2netp", (2, 2), &output).unwrap();
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
        let output = ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 16, 16]), data).unwrap();
        let mask = postprocess("rmbg-1.4", (16, 16), &output).unwrap();
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
        let output = ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 16, 16]), data).unwrap();
        let mask = postprocess("isnet-general-use", (16, 16), &output).unwrap();
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
        let output = ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 16, 16]), data).unwrap();
        let mask = postprocess("birefnet-general-lite", (16, 16), &output).unwrap();
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
    fn postprocess_unknown_model_returns_error() {
        let output = ndarray::ArrayD::from_shape_vec(
            ndarray::IxDyn(&[1, 1, 2, 2]),
            vec![0.0f32; 4],
        )
        .unwrap();
        let result = postprocess("unknown", (2, 2), &output);
        assert!(result.is_err());
    }

}
