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
        "rmbg-1.4" => postprocess_rmbg_1_4(original_size, output),
        "u2netp" | "isnet-general-use" | "rmbg-2.0" => postprocess_minmax(original_size, output),
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
    let min = logits.iter().copied().fold(f32::INFINITY, f32::min);
    let max = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let range = max - min;
    let mut mask = GrayImage::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let v = logits[y * w + x];
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

/// RMBG-1.4 refine knobs (Phase 1).
///
/// Island removal runs on a hard binary core; soft subject alpha is restored under a
/// dilated support so hair/foam/glass fringes and mid-alpha interiors survive.
const RMBG14_BINARY_THRESH: f32 = 0.2;
const RMBG14_OPEN_R: i32 = 1;
const RMBG14_CLOSE_R: i32 = 1;
/// Dilate kept CC support so soft mid-alpha fringe outside the hard core is reapplied.
const RMBG14_FRINGE_DILATE_R: i32 = 2;
const RMBG14_EDGE_BAND_R: i32 = 2;
const RMBG14_EDGE_SIGMA: f32 = 1.0;

/// RMBG-1.4 refine stack: percentile norm → soft contrast → morph open →
/// keep large CCs → light hole fill → reapply soft α under dilated support →
/// upsample → edge-band feather (preserves soft interiors).
fn postprocess_rmbg_1_4(
    original_size: (u32, u32),
    output: &ndarray::ArrayD<f32>,
) -> Result<GrayImage, AppError> {
    let (h, w, logits) = extract_logits(output)?;
    let alpha = percentile_normalize(&logits);
    // Soft map for final subject alpha (contrast push; mid-band preserved).
    let soft: Vec<f32> = alpha.into_iter().map(soft_threshold).collect();

    // Binary is only for junk morph/CC — not the final alpha.
    let mut binary = alpha_to_binary(&soft, w, h, RMBG14_BINARY_THRESH);
    binary = morph_open(&binary, RMBG14_OPEN_R);
    binary = keep_large_components(&binary);
    // Small close after CC: fills 1-px holes inside kept subjects without re-merging junk.
    binary = morph_close(&binary, RMBG14_CLOSE_R);
    // Soft fringe recovery: reapply soft α under a dilated kept support.
    let support = morph_dilate(&binary, RMBG14_FRINGE_DILATE_R);

    let mut refined = GrayImage::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let v = if support.get_pixel(x as u32, y as u32)[0] > 0 {
                soft[i]
            } else {
                0.0
            };
            refined.put_pixel(x as u32, y as u32, image::Luma([(v * 255.0).round() as u8]));
        }
    }

    let resized =
        image::imageops::resize(&refined, original_size.0, original_size.1, FilterType::Lanczos3);
    Ok(edge_band_feather(
        &resized,
        RMBG14_EDGE_BAND_R,
        RMBG14_EDGE_SIGMA,
    ))
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

/// 1st–99th percentile stretch to [0, 1]; falls back to min-max if degenerate.
fn percentile_normalize(logits: &[f32]) -> Vec<f32> {
    let n = logits.len();
    if n == 0 {
        return Vec::new();
    }
    let mut sorted: Vec<f32> = logits.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let lo_idx = ((n.saturating_sub(1)) as f32 * 0.01).round() as usize;
    let hi_idx = ((n.saturating_sub(1)) as f32 * 0.99).round() as usize;
    let lo = sorted[lo_idx.min(n - 1)];
    let hi = sorted[hi_idx.min(n - 1)];
    let range = hi - lo;

    if range > 1e-6 {
        return logits
            .iter()
            .map(|v| ((v - lo) / range).clamp(0.0, 1.0))
            .collect();
    }

    let min = sorted[0];
    let max = sorted[n - 1];
    let range = max - min;
    if range == 0.0 {
        return vec![0.0; n];
    }
    logits.iter().map(|v| (v - min) / range).collect()
}

/// Push near-bg → 0 and near-fg → 1; smoothstep mid-band for soft edges.
/// Constants: lo=0.15, hi=0.85.
fn soft_threshold(a: f32) -> f32 {
    const LO: f32 = 0.15;
    const HI: f32 = 0.85;
    if a <= LO {
        0.0
    } else if a >= HI {
        1.0
    } else {
        let t = (a - LO) / (HI - LO);
        t * t * (3.0 - 2.0 * t)
    }
}

fn alpha_to_binary(alpha: &[f32], w: usize, h: usize, thresh: f32) -> GrayImage {
    let mut img = GrayImage::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let v = if alpha[y * w + x] > thresh { 255 } else { 0 };
            img.put_pixel(x as u32, y as u32, image::Luma([v]));
        }
    }
    img
}

/// Square structuring element of radius `r` (diameter 2r+1). Erode: all neighbors fg.
fn morph_erode(src: &GrayImage, r: i32) -> GrayImage {
    let (w, h) = src.dimensions();
    let mut dst = GrayImage::new(w, h);
    let wi = w as i32;
    let hi = h as i32;
    for y in 0..hi {
        for x in 0..wi {
            let mut fg = true;
            'nbr: for dy in -r..=r {
                for dx in -r..=r {
                    let nx = x + dx;
                    let ny = y + dy;
                    if nx < 0 || ny < 0 || nx >= wi || ny >= hi || src.get_pixel(nx as u32, ny as u32)[0] == 0
                    {
                        fg = false;
                        break 'nbr;
                    }
                }
            }
            dst.put_pixel(x as u32, y as u32, image::Luma([if fg { 255 } else { 0 }]));
        }
    }
    dst
}

/// Dilate: any neighbor fg.
fn morph_dilate(src: &GrayImage, r: i32) -> GrayImage {
    let (w, h) = src.dimensions();
    let mut dst = GrayImage::new(w, h);
    let wi = w as i32;
    let hi = h as i32;
    for y in 0..hi {
        for x in 0..wi {
            let mut fg = false;
            'nbr: for dy in -r..=r {
                for dx in -r..=r {
                    let nx = x + dx;
                    let ny = y + dy;
                    if nx >= 0
                        && ny >= 0
                        && nx < wi
                        && ny < hi
                        && src.get_pixel(nx as u32, ny as u32)[0] > 0
                    {
                        fg = true;
                        break 'nbr;
                    }
                }
            }
            dst.put_pixel(x as u32, y as u32, image::Luma([if fg { 255 } else { 0 }]));
        }
    }
    dst
}

fn morph_open(src: &GrayImage, r: i32) -> GrayImage {
    morph_dilate(&morph_erode(src, r), r)
}

fn morph_close(src: &GrayImage, r: i32) -> GrayImage {
    morph_erode(&morph_dilate(src, r), r)
}

/// Keep the largest connected component plus any additional whose area is
/// ≥ max(5% of largest, 0.25% of total pixels). The largest is always kept,
/// even when it falls under the absolute area floor (small product / logo).
fn keep_large_components(src: &GrayImage) -> GrayImage {
    let (w, h) = src.dimensions();
    let total = (w as usize) * (h as usize);
    let mut labels = vec![0i32; total];
    let mut areas: Vec<usize> = Vec::new(); // areas[label-1]
    let mut next_label: i32 = 1;

    let idx = |x: u32, y: u32| -> usize { y as usize * w as usize + x as usize };

    for y in 0..h {
        for x in 0..w {
            if src.get_pixel(x, y)[0] == 0 || labels[idx(x, y)] != 0 {
                continue;
            }
            // BFS flood-fill
            let label = next_label;
            next_label += 1;
            let mut area = 0usize;
            let mut stack = vec![(x, y)];
            labels[idx(x, y)] = label;
            while let Some((cx, cy)) = stack.pop() {
                area += 1;
                for (dx, dy) in [(-1i32, 0), (1, 0), (0, -1), (0, 1)] {
                    let nx = cx as i32 + dx;
                    let ny = cy as i32 + dy;
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    let nx = nx as u32;
                    let ny = ny as u32;
                    let i = idx(nx, ny);
                    if labels[i] == 0 && src.get_pixel(nx, ny)[0] > 0 {
                        labels[i] = label;
                        stack.push((nx, ny));
                    }
                }
            }
            areas.push(area);
        }
    }

    if areas.is_empty() {
        return GrayImage::new(w, h);
    }

    let largest = *areas.iter().max().unwrap();
    // Floor applies only to *additional* components — never drop the primary.
    let min_keep = ((largest as f32) * 0.05)
        .max((total as f32) * 0.0025)
        .ceil() as usize;

    let mut keep = vec![false; areas.len()];
    for (i, &a) in areas.iter().enumerate() {
        keep[i] = a == largest || a >= min_keep;
    }

    let mut out = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let lab = labels[idx(x, y)];
            let v = if lab > 0 && keep[(lab - 1) as usize] {
                255
            } else {
                0
            };
            out.put_pixel(x, y, image::Luma([v]));
        }
    }
    out
}

/// Feather only near the boundary: far-fg keeps original α (soft interiors),
/// far-bg → 0, band uses blurred α.
/// `radius` is the morph band half-width in pixels; `sigma` is the Gaussian σ in-band.
///
/// Band construction treats any non-zero α as FG so soft_threshold midpoints
/// (≈127) and semi-transparent interiors stay inside the subject support.
fn edge_band_feather(mask: &GrayImage, radius: i32, sigma: f32) -> GrayImage {
    let (w, h) = mask.dimensions();
    if w == 0 || h == 0 {
        return mask.clone();
    }

    // Any residual subject alpha builds the hard core (not mid-gray 128).
    let mut hard = GrayImage::new(w, h);
    for (x, y, p) in mask.enumerate_pixels() {
        hard.put_pixel(x, y, image::Luma([if p[0] > 0 { 255 } else { 0 }]));
    }
    let eroded = morph_erode(&hard, radius);
    let dilated = morph_dilate(&hard, radius);
    let blurred = image::imageops::blur(mask, sigma);

    let mut out = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let deep_fg = eroded.get_pixel(x, y)[0] > 0;
            let near_fg = dilated.get_pixel(x, y)[0] > 0;
            let v = if deep_fg {
                // Preserve soft interiors (glass/foam/veil); do not force 255.
                mask.get_pixel(x, y)[0]
            } else if !near_fg {
                0
            } else {
                blurred.get_pixel(x, y)[0]
            };
            out.put_pixel(x, y, image::Luma([v]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::find_model;

    fn gray_from_fn(w: u32, h: u32, f: impl Fn(u32, u32) -> u8) -> GrayImage {
        let mut img = GrayImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, image::Luma([f(x, y)]));
            }
        }
        img
    }

    fn count_fg(img: &GrayImage, thresh: u8) -> usize {
        img.pixels().filter(|p| p[0] > thresh).count()
    }

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
    fn postprocess_rmbg_1_4_refine_preserves_block_and_edge_band() {
        // Half-plane subject: deep interior should be fully opaque after edge-band feather.
        let mut data = Vec::with_capacity(32 * 32);
        for _y in 0..32 {
            for x in 0..32 {
                let v = if x < 16 { 10.0f32 } else { -10.0f32 };
                data.push(v);
            }
        }
        let output = ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 32, 32]), data).unwrap();
        let mask = postprocess("rmbg-1.4", (32, 32), &output).unwrap();
        assert_eq!(mask.dimensions(), (32, 32));
        // Far-fg (well inside left half) stays hard 255 under edge-band feather.
        assert_eq!(mask.get_pixel(4, 16)[0], 255);
        // Far-bg stays hard 0.
        assert_eq!(mask.get_pixel(28, 16)[0], 0);
        // Boundary band is soft.
        let edge = mask.get_pixel(16, 16)[0];
        assert!(edge > 10 && edge < 245, "edge alpha was {edge}");
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
    fn postprocess_unknown_model_returns_error() {
        let output = ndarray::ArrayD::from_shape_vec(
            ndarray::IxDyn(&[1, 1, 2, 2]),
            vec![0.0f32; 4],
        )
        .unwrap();
        let result = postprocess("unknown", (2, 2), &output);
        assert!(result.is_err());
    }

    #[test]
    fn percentile_normalize_clips_outliers() {
        // Mostly mid-range with extreme outliers that absolute min-max would over-stretch.
        let mut logits = vec![0.5f32; 100];
        logits[0] = -100.0;
        logits[1] = 100.0;
        for i in 2..50 {
            logits[i] = 0.2;
        }
        for i in 50..100 {
            logits[i] = 0.8;
        }
        let n = percentile_normalize(&logits);
        // After 1–99 percentile, extremes clamp and mid values keep separation.
        assert!(n[0] <= 0.01);
        assert!(n[1] >= 0.99);
        assert!(n[10] < n[60]);
    }

    #[test]
    fn percentile_normalize_uniform_is_zero() {
        let n = percentile_normalize(&[3.0, 3.0, 3.0, 3.0]);
        assert!(n.iter().all(|&v| v == 0.0));
    }

    #[test]
    fn soft_threshold_constants() {
        assert_eq!(soft_threshold(0.0), 0.0);
        assert_eq!(soft_threshold(0.15), 0.0);
        assert_eq!(soft_threshold(0.85), 1.0);
        assert_eq!(soft_threshold(1.0), 1.0);
        let mid = soft_threshold(0.5);
        assert!(mid > 0.4 && mid < 0.6, "mid was {mid}");
    }

    #[test]
    fn keep_large_components_drops_floating_islands() {
        // 20×20 main blob + two tiny islands.
        let img = gray_from_fn(40, 40, |x, y| {
            let main = x >= 10 && x < 30 && y >= 10 && y < 30;
            let island_a = x >= 1 && x < 3 && y >= 1 && y < 3;
            let island_b = x >= 36 && x < 39 && y >= 36 && y < 39;
            if main || island_a || island_b {
                255
            } else {
                0
            }
        });
        let cleaned = keep_large_components(&img);
        // Main blob survives.
        assert!(cleaned.get_pixel(20, 20)[0] > 0);
        // Tiny islands removed.
        assert_eq!(cleaned.get_pixel(1, 1)[0], 0);
        assert_eq!(cleaned.get_pixel(37, 37)[0], 0);
        let fg = count_fg(&cleaned, 0);
        assert!(fg >= 380 && fg <= 420, "fg count {fg}");
    }

    #[test]
    fn keep_large_components_keeps_two_large_subjects() {
        // Two 12×12 blobs on a 40×40 canvas — both well above the size floor.
        let img = gray_from_fn(40, 40, |x, y| {
            let a = x >= 2 && x < 14 && y >= 2 && y < 14;
            let b = x >= 26 && x < 38 && y >= 26 && y < 38;
            if a || b {
                255
            } else {
                0
            }
        });
        let kept = keep_large_components(&img);
        assert!(kept.get_pixel(8, 8)[0] > 0);
        assert!(kept.get_pixel(32, 32)[0] > 0);
        let fg = count_fg(&kept, 0);
        assert_eq!(fg, 12 * 12 * 2);
    }

    #[test]
    fn keep_large_components_keeps_small_primary_under_floor() {
        // Sole ~30×30 blob on 1024²: area 900 < 0.25% of total (≈2622).
        // Floor must NOT erase the primary subject.
        let side = 1024u32;
        let blob = 30u32;
        let x0 = (side - blob) / 2;
        let y0 = (side - blob) / 2;
        let img = gray_from_fn(side, side, |x, y| {
            if x >= x0 && x < x0 + blob && y >= y0 && y < y0 + blob {
                255
            } else {
                0
            }
        });
        let kept = keep_large_components(&img);
        assert!(
            kept.get_pixel(x0 + blob / 2, y0 + blob / 2)[0] > 0,
            "small primary subject must survive absolute area floor"
        );
        assert_eq!(count_fg(&kept, 0), (blob * blob) as usize);
    }

    #[test]
    fn morph_open_breaks_thin_bridge() {
        // Two blocks linked by a 1-px-wide bridge; 3×3 open should sever it.
        let img = gray_from_fn(20, 10, |x, y| {
            let left = x < 6 && y >= 2 && y < 8;
            let right = x >= 14 && y >= 2 && y < 8;
            let bridge = x >= 6 && x < 14 && y == 5;
            if left || right || bridge {
                255
            } else {
                0
            }
        });
        let opened = morph_open(&img, 1);
        assert_eq!(opened.get_pixel(10, 5)[0], 0);
        assert!(opened.get_pixel(2, 5)[0] > 0);
        assert!(opened.get_pixel(17, 5)[0] > 0);
    }

    #[test]
    fn postprocess_rmbg_1_4_removes_floating_islands() {
        // Strong central subject + weak disconnected junk corners.
        let mut data = vec![-5.0f32; 64 * 64];
        for y in 16..48 {
            for x in 16..48 {
                data[y * 64 + x] = 8.0;
            }
        }
        // Tiny bright islands (floating junk).
        for y in 1..4 {
            for x in 1..4 {
                data[y * 64 + x] = 7.0;
            }
        }
        for y in 60..63 {
            for x in 60..63 {
                data[y * 64 + x] = 7.0;
            }
        }
        let output =
            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 64, 64]), data).unwrap();
        let mask = postprocess("rmbg-1.4", (64, 64), &output).unwrap();
        assert_eq!(mask.dimensions(), (64, 64));
        // Main subject intact.
        assert!(mask.get_pixel(32, 32)[0] > 200);
        // Islands gone (or near-zero after refine).
        assert!(
            mask.get_pixel(2, 2)[0] < 20,
            "island a alpha={}",
            mask.get_pixel(2, 2)[0]
        );
        assert!(
            mask.get_pixel(61, 61)[0] < 20,
            "island b alpha={}",
            mask.get_pixel(61, 61)[0]
        );
    }

    #[test]
    fn postprocess_rmbg_1_4_keeps_two_large_subjects() {
        let mut data = vec![-5.0f32; 64 * 64];
        for y in 4..28 {
            for x in 4..28 {
                data[y * 64 + x] = 8.0;
            }
        }
        for y in 36..60 {
            for x in 36..60 {
                data[y * 64 + x] = 8.0;
            }
        }
        let output =
            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 64, 64]), data).unwrap();
        let mask = postprocess("rmbg-1.4", (64, 64), &output).unwrap();
        assert!(mask.get_pixel(16, 16)[0] > 200);
        assert!(mask.get_pixel(48, 48)[0] > 200);
    }

    #[test]
    fn postprocess_rmbg_1_4_uniform_logits_safe() {
        let output = ndarray::ArrayD::from_shape_vec(
            ndarray::IxDyn(&[1, 1, 8, 8]),
            vec![0.42f32; 64],
        )
        .unwrap();
        let mask = postprocess("rmbg-1.4", (8, 8), &output).unwrap();
        assert_eq!(mask.dimensions(), (8, 8));
        for p in mask.pixels() {
            assert_eq!(p[0], 0);
        }
    }

    #[test]
    fn postprocess_rmbg_1_4_preserves_mid_alpha_interior() {
        // Glass/foam-like subject: solid core + large mid-confidence interior block.
        // After soft_threshold the interior is ~0.5; edge_band must NOT flatten to 0/255.
        let mut data = vec![-8.0f32; 64 * 64];
        for y in 12..52 {
            for x in 12..52 {
                // Mid logits relative to bg/fg extremes → soft_threshold mid-band.
                data[y * 64 + x] = 0.0;
            }
        }
        // Bright rim so morph/CC has a solid support around the mid interior.
        for y in 12..52 {
            for x in 12..52 {
                let rim = x < 16 || x >= 48 || y < 16 || y >= 48;
                if rim {
                    data[y * 64 + x] = 8.0;
                }
            }
        }
        let output =
            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 64, 64]), data).unwrap();
        let mask = postprocess("rmbg-1.4", (64, 64), &output).unwrap();
        let mid = mask.get_pixel(32, 32)[0];
        assert!(
            mid > 40 && mid < 220,
            "mid-alpha interior crushed to {mid}; expected soft mid-range"
        );
        // Far background still clean.
        assert!(mask.get_pixel(2, 2)[0] < 20);
    }

    #[test]
    fn postprocess_rmbg_1_4_preserves_soft_fringe() {
        // Hair/fur-like soft border: solid core + 2px mid-alpha fringe, plus a distant
        // high-confidence junk island that must still die.
        let mut data = vec![-8.0f32; 64 * 64];
        for y in 20..44 {
            for x in 20..44 {
                data[y * 64 + x] = 8.0;
            }
        }
        // Soft fringe ring (normalized mid after percentile; soft_threshold keeps mids).
        for y in 18..46 {
            for x in 18..46 {
                let in_core = x >= 20 && x < 44 && y >= 20 && y < 44;
                if !in_core {
                    data[y * 64 + x] = 1.0;
                }
            }
        }
        // Distant bright junk island.
        for y in 2..5 {
            for x in 2..5 {
                data[y * 64 + x] = 7.0;
            }
        }
        let output =
            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 64, 64]), data).unwrap();
        let mask = postprocess("rmbg-1.4", (64, 64), &output).unwrap();
        // Core opaque-ish.
        assert!(mask.get_pixel(32, 32)[0] > 200);
        // Soft fringe must not be crushed to 0 (recovered under dilated support / band).
        let fringe = mask.get_pixel(19, 32)[0];
        assert!(
            fringe > 15,
            "soft fringe crushed to {fringe}; expected non-zero mid-alpha border"
        );
        // Island still removed.
        assert!(
            mask.get_pixel(3, 3)[0] < 20,
            "junk island alpha={}",
            mask.get_pixel(3, 3)[0]
        );
    }

    #[test]
    fn postprocess_rmbg_1_4_keeps_thin_protrusion_drops_island() {
        // Beer-mug class: large body + attached 3px-wide handle + distant tiny island.
        // Open r=1 severs 1px bridges but must not erase a 3px attached protrusion.
        let mut data = vec![-8.0f32; 64 * 64];
        // Main body 24×24.
        for y in 16..40 {
            for x in 12..36 {
                data[y * 64 + x] = 8.0;
            }
        }
        // Attached handle: 3px wide × 12px tall, connected on the right side.
        for y in 22..34 {
            for x in 36..39 {
                data[y * 64 + x] = 8.0;
            }
        }
        // Distant tiny island (junk).
        for y in 2..5 {
            for x in 55..58 {
                data[y * 64 + x] = 7.0;
            }
        }
        let output =
            ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 64, 64]), data).unwrap();
        let mask = postprocess("rmbg-1.4", (64, 64), &output).unwrap();
        assert!(mask.get_pixel(24, 28)[0] > 200, "body missing");
        assert!(
            mask.get_pixel(37, 28)[0] > 100,
            "thin attached protrusion dropped (handle alpha={})",
            mask.get_pixel(37, 28)[0]
        );
        assert!(
            mask.get_pixel(56, 3)[0] < 20,
            "floating island survived (alpha={})",
            mask.get_pixel(56, 3)[0]
        );
    }

    #[test]
    fn postprocess_rmbg_1_4_keeps_small_primary_subject() {
        // Canvas where 0.25% absolute floor binds: side=256 → floor ≈164 px.
        // Sole 12×12 (=144) primary is under that floor but must still survive.
        let side = 256usize;
        let mut data = vec![-5.0f32; side * side];
        let blob = 12usize;
        let x0 = (side - blob) / 2;
        let y0 = (side - blob) / 2;
        for y in y0..y0 + blob {
            for x in x0..x0 + blob {
                data[y * side + x] = 8.0;
            }
        }
        // Plus a tiny island that should still die.
        for y in 2..4 {
            for x in 2..4 {
                data[y * side + x] = 7.0;
            }
        }
        let output = ndarray::ArrayD::from_shape_vec(
            ndarray::IxDyn(&[1, 1, side, side]),
            data,
        )
        .unwrap();
        let mask = postprocess("rmbg-1.4", (side as u32, side as u32), &output).unwrap();
        let cx = (x0 + blob / 2) as u32;
        let cy = (y0 + blob / 2) as u32;
        assert!(
            mask.get_pixel(cx, cy)[0] > 200,
            "small primary subject empty (alpha={})",
            mask.get_pixel(cx, cy)[0]
        );
        assert!(mask.get_pixel(3, 3)[0] < 20);
    }

    #[test]
    fn postprocess_rmbg_2_0_still_minmax_blur() {
        // rmbg-2.0 keeps the legacy global-blur path.
        let mut data = Vec::with_capacity(16 * 16);
        for _y in 0..16 {
            for x in 0..16 {
                data.push(if x < 8 { 10.0f32 } else { -10.0f32 });
            }
        }
        let output = ndarray::ArrayD::from_shape_vec(ndarray::IxDyn(&[1, 1, 16, 16]), data).unwrap();
        let mask = postprocess("rmbg-2.0", (16, 16), &output).unwrap();
        let min_pixel = mask.pixels().map(|p| p[0]).min().unwrap();
        let max_pixel = mask.pixels().map(|p| p[0]).max().unwrap();
        assert!(min_pixel < 10);
        assert!(max_pixel > 245);
        let edge = mask.get_pixel(8, 8)[0];
        assert!(edge > 10 && edge < 245);
    }

    #[test]
    fn edge_band_feather_hard_interior() {
        let img = gray_from_fn(20, 20, |x, y| {
            if x >= 5 && x < 15 && y >= 5 && y < 15 {
                255
            } else {
                0
            }
        });
        let out = edge_band_feather(&img, 2, 1.0);
        assert_eq!(out.get_pixel(10, 10)[0], 255);
        assert_eq!(out.get_pixel(0, 0)[0], 0);
        let band = out.get_pixel(5, 10)[0];
        assert!(band < 255, "band should not be hard 255, got {band}");
    }

    #[test]
    fn edge_band_feather_preserves_soft_interior() {
        // Deep mid-alpha must stay mid-range (not forced to 255).
        let img = gray_from_fn(20, 20, |x, y| {
            if x >= 5 && x < 15 && y >= 5 && y < 15 {
                128
            } else {
                0
            }
        });
        let out = edge_band_feather(&img, 2, 1.0);
        let interior = out.get_pixel(10, 10)[0];
        assert!(
            (interior as i16 - 128).abs() <= 2,
            "soft interior flattened to {interior}"
        );
        assert_eq!(out.get_pixel(0, 0)[0], 0);
    }
}
