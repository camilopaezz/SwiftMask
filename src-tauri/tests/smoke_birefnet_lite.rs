//! Manual smoke: load High-mode BiRefNet lite-512 ONNX, run inference, dump masks.
//!
//! ```bash
//! BIREFNET_ONNX=/tmp/swiftmask-models/birefnet-lite-512.onnx \
//! BIREFNET_IMAGE=/home/camilo/Pictures/Gisele_Bundchen2.jpg \
//! cargo test --manifest-path src-tauri/Cargo.toml --test smoke_birefnet_lite -- --nocapture
//! ```
//!
//! Skips when `BIREFNET_ONNX` is unset so normal `cargo test` stays fast.

use std::path::PathBuf;
use std::time::Instant;

use image::{GrayImage, RgbImage};
use ndarray::{ArrayD, Axis};
use swiftmask_lib::{image_io, inference, models, pipeline};

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from)
}

fn logit_stats(output: &ArrayD<f32>) -> (Vec<usize>, f32, f32, f32, f32) {
    let shape = output.shape().to_vec();
    let mut min = f32::INFINITY;
    let mut max = f32::NEG_INFINITY;
    let mut sum = 0.0f64;
    let mut n = 0u64;
    let mut neg = 0u64;
    let mut above_one = 0u64;
    for &v in output.iter() {
        min = min.min(v);
        max = max.max(v);
        sum += f64::from(v);
        n += 1;
        if v < 0.0 {
            neg += 1;
        }
        if v > 1.0 {
            above_one += 1;
        }
    }
    let mean = if n == 0 { 0.0 } else { (sum / n as f64) as f32 };
    let frac_neg = if n == 0 { 0.0 } else { neg as f32 / n as f32 };
    let frac_gt1 = if n == 0 {
        0.0
    } else {
        above_one as f32 / n as f32
    };
    let _ = (frac_neg, frac_gt1); // printed below
    println!(
        "logits: shape={:?} min={:.4} max={:.4} mean={:.4} frac_neg={:.3} frac>1={:.3}",
        shape, min, max, mean, frac_neg, frac_gt1
    );
    (shape, min, max, mean, frac_neg)
}

/// Raw min-max without sigmoid — wrong for BiRefNet (washed masks); kept for A/B dumps.
fn raw_minmax(original_size: (u32, u32), output: &ArrayD<f32>) -> GrayImage {
    let shape = output.shape();
    assert_eq!(shape.len(), 4);
    assert_eq!(shape[0], 1);
    assert_eq!(shape[1], 1);
    let h = shape[2];
    let w = shape[3];
    let batch = output.index_axis(Axis(0), 0);
    let plane = batch.index_axis(Axis(0), 0);
    let logits: Vec<f32> = plane.iter().copied().collect();
    let min = logits.iter().copied().fold(f32::INFINITY, f32::min);
    let max = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let range = max - min;
    let mut mask = GrayImage::new(w as u32, h as u32);
    for y in 0..h {
        for x in 0..w {
            let v = logits[y * w + x];
            let n = if range == 0.0 { 0.0 } else { (v - min) / range };
            mask.put_pixel(x as u32, y as u32, image::Luma([(n * 255.0).round() as u8]));
        }
    }
    let resized =
        image::imageops::resize(&mask, original_size.0, original_size.1, image::imageops::FilterType::Lanczos3);
    image::imageops::blur(&resized, 1.0)
}

fn mask_histogram(mask: &GrayImage) -> (u8, u8, f32, f32) {
    let mut min = 255u8;
    let mut max = 0u8;
    let mut sum = 0u64;
    let mut near0 = 0u64;
    let mut near255 = 0u64;
    let n = mask.width() as u64 * mask.height() as u64;
    for p in mask.pixels() {
        let v = p[0];
        min = min.min(v);
        max = max.max(v);
        sum += u64::from(v);
        if v < 16 {
            near0 += 1;
        }
        if v > 239 {
            near255 += 1;
        }
    }
    let mean = sum as f32 / n as f32;
    let frac_extreme = (near0 + near255) as f32 / n as f32;
    (min, max, mean, frac_extreme)
}

fn write_rgba(path: &PathBuf, rgb: &RgbImage, alpha: &GrayImage) {
    let bytes = image_io::encode_png_rgba(rgb, alpha).unwrap();
    std::fs::write(path, bytes).unwrap();
    println!("wrote {}", path.display());
}

#[test]
fn birefnet_general_lite_smoke() {
    let onnx = match env_path("BIREFNET_ONNX") {
        Some(p) if p.is_file() => p,
        _ => {
            eprintln!("skip: set BIREFNET_ONNX to the downloaded ONNX path");
            return;
        }
    };
    let image_path = env_path("BIREFNET_IMAGE").unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sample.png")
    });
    assert!(
        image_path.is_file(),
        "image not found: {}",
        image_path.display()
    );

    let out_dir = env_path("BIREFNET_OUT").unwrap_or_else(|| PathBuf::from("/tmp/swiftmask-birefnet-smoke"));
    std::fs::create_dir_all(&out_dir).unwrap();

    let image_bytes = std::fs::read(&image_path).unwrap();
    let image = image_io::decode(&image_bytes).unwrap();
    let original_size = (image.width(), image.height());
    let rgb = image.to_rgb8();
    println!(
        "image {} {}x{}",
        image_path.display(),
        original_size.0,
        original_size.1
    );

    let model = models::find_model("birefnet-general-lite").unwrap();
    assert_eq!(model.input_size, 512);
    let tensor = pipeline::preprocess(model, &image).unwrap();
    assert_eq!(tensor.shape(), &[1, 3, 512, 512]);

    let model_bytes = std::fs::read(&onnx).unwrap();
    assert_eq!(model_bytes.len() as u64, model.size_bytes);
    let sha = models::sha256_file(&onnx).unwrap();
    assert_eq!(sha, model.sha256, "ONNX SHA mismatch");

    println!("loading session (cpu)…");
    let t0 = Instant::now();
    let mut session = inference::load_session_from_bytes(&model_bytes, inference::EP_CPU).unwrap();
    println!("load {:.2}s", t0.elapsed().as_secs_f32());

    println!("running inference…");
    let t1 = Instant::now();
    let output = inference::run(&mut session, &tensor).unwrap();
    let infer_s = t1.elapsed().as_secs_f32();
    println!("infer {:.2}s", infer_s);

    let (shape, min, max, _mean, frac_neg) = logit_stats(&output);
    assert_eq!(shape.len(), 4, "expected NCHW output");
    assert_eq!(shape[0], 1);
    assert_eq!(
        shape[1], 1,
        "expected single-channel mask, got shape {:?}",
        shape
    );
    // BiRefNet logits are typically unbounded (both signs); pure probs would sit in [0,1].
    println!(
        "dynamic range {:.4} (if mostly in [0,1] with few negatives, already-activated)",
        max - min
    );

    // Production path (sigmoid → min-max).
    let alpha_prod =
        pipeline::postprocess("birefnet-general-lite", original_size, &output).unwrap();
    let (mn, mx, mean, frac_ext) = mask_histogram(&alpha_prod);
    println!(
        "production (sigmoid+minmax): min={} max={} mean={:.1} frac_near_extreme={:.3}",
        mn, mx, mean, frac_ext
    );

    // Ablation: raw min-max only (historically washed on BiRefNet).
    let alpha_raw = raw_minmax(original_size, &output);
    let (mn2, mx2, mean2, frac_ext2) = mask_histogram(&alpha_raw);
    println!(
        "raw minmax only: min={} max={} mean={:.1} frac_near_extreme={:.3}",
        mn2, mx2, mean2, frac_ext2
    );

    write_rgba(&out_dir.join("high-production.png"), &rgb, &alpha_prod);
    write_rgba(&out_dir.join("high-raw-minmax.png"), &rgb, &alpha_raw);
    alpha_prod
        .save(out_dir.join("high-production-mask.png"))
        .unwrap();
    alpha_raw
        .save(out_dir.join("high-raw-minmax-mask.png"))
        .unwrap();

    assert!(mn < 20 && mx > 235, "production mask not full range");
    // Production should be much more binary than raw min-max on BiRefNet logits.
    assert!(
        frac_ext > 0.5,
        "expected saturated mask after sigmoid, frac_near_extreme={frac_ext}"
    );
    if frac_neg > 0.05 && max > 2.0 {
        assert!(
            frac_ext > frac_ext2 + 0.3,
            "sigmoid path should be far more saturated than raw minmax ({frac_ext} vs {frac_ext2})"
        );
    }

    println!("done. compare PNGs in {}", out_dir.display());
}
