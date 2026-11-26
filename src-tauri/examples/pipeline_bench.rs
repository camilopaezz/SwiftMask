//! Stage-by-stage CPU benchmark of the background-removal pipeline.
//!
//! ```bash
//! cargo run --release --manifest-path src-tauri/Cargo.toml --example pipeline_bench
//! # Optional: real photo and/or a downloaded model
//! BENCH_IMAGE=~/Pictures/photo.jpg \
//! BENCH_MODEL=isnet-general-use \
//! BENCH_ONNX=~/.local/share/com.camilo.swiftmask/models/isnet-general-use.onnx \
//! cargo run --release --manifest-path src-tauri/Cargo.toml --example pipeline_bench
//! ```
//!
//! `BENCH_DUMP_MASK=out.png` saves the alpha mask (for comparing pipeline changes).
//! Without `BENCH_IMAGE` a synthetic 4032x3024 JPEG (12 MP phone photo) is used.
//! Without `BENCH_ONNX` the bundled u2netp model runs.

use std::time::{Duration, Instant};

use image::{DynamicImage, ImageFormat, RgbImage};
use swiftmask_lib::{image_io, inference, models, pipeline};

fn time<T>(label: &str, runs: usize, mut f: impl FnMut() -> T) -> T {
    let mut best = Duration::MAX;
    let mut out = None;
    for _ in 0..runs {
        let start = Instant::now();
        let v = f();
        best = best.min(start.elapsed());
        out = Some(v);
    }
    println!(
        "{label:<16} {:>9.1} ms (best of {runs})",
        best.as_secs_f64() * 1e3
    );
    out.expect("runs > 0")
}

fn synthetic_jpeg() -> Vec<u8> {
    let (w, h) = (4032u32, 3024u32);
    let mut seed = 0x2545_f491_u32;
    let rgb = RgbImage::from_fn(w, h, |x, y| {
        // Xorshift noise approximates sensor grain so JPEG/PNG sizes are photo-like.
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        let n = (seed & 0x1f) as u8;
        // Smooth gradients + a bright "subject" disc so models produce a real mask.
        let dx = x as f32 - w as f32 / 2.0;
        let dy = y as f32 - h as f32 / 2.0;
        let inside = dx * dx + dy * dy < (h as f32 / 3.0).powi(2);
        if inside {
            image::Rgb([200 + n, (x % 224) as u8 + n, 60 + n])
        } else {
            image::Rgb([(x / 16 % 224) as u8 + n, (y / 12 % 224) as u8 + n, 110 + n])
        }
    });
    let mut buf = Vec::new();
    rgb.write_to(&mut std::io::Cursor::new(&mut buf), ImageFormat::Jpeg)
        .expect("encode synthetic jpeg");
    buf
}

fn main() {
    let runs: usize = std::env::var("BENCH_RUNS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3);
    let bytes = match std::env::var_os("BENCH_IMAGE") {
        Some(p) => std::fs::read(p).expect("read BENCH_IMAGE"),
        None => synthetic_jpeg(),
    };
    let model_id = std::env::var("BENCH_MODEL").unwrap_or_else(|_| "u2netp".into());
    let model = models::find_model(&model_id).expect("known model id");
    let onnx = match std::env::var_os("BENCH_ONNX") {
        Some(p) => std::fs::read(p).expect("read BENCH_ONNX"),
        None => inference::U2NETP_MODEL_BYTES.to_vec(),
    };

    let img: DynamicImage = time("decode", runs, || image_io::decode(&bytes).unwrap());
    let size = (img.width(), img.height());
    println!("image            {}x{} ({:?})", size.0, size.1, img.color());

    let tensor = time("preprocess", runs, || {
        pipeline::preprocess(model, &img).unwrap()
    });
    let rgb = time("into_rgb8", 1, || img.clone().into_rgb8());

    let mut session = time("session load", 1, || {
        inference::load_session_from_bytes(&onnx, inference::EP_CPU).unwrap()
    });
    // Warm-up run so the timed runs measure steady state.
    let _ = inference::run(&mut session, &tensor).unwrap();
    let output = time("inference", runs, || {
        inference::run(&mut session, &tensor).unwrap()
    });

    let alpha = time("postprocess", runs, || {
        pipeline::postprocess(model, size, &output).unwrap()
    });
    if let Some(path) = std::env::var_os("BENCH_DUMP_MASK") {
        alpha.save(path).expect("write BENCH_DUMP_MASK");
    }
    let png = time("encode png", runs, || {
        image_io::encode_png_rgba(&rgb, &alpha).unwrap()
    });
    println!(
        "output png       {:.1} MiB",
        png.len() as f64 / (1024.0 * 1024.0)
    );
}
