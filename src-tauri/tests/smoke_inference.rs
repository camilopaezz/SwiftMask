use std::path::PathBuf;

use swiftmask_lib::{image_io, inference, models, pipeline};

#[test]
fn u2netp_smoke_iou() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let sample_path = root.join("tests/fixtures/sample.png");
    let mask_path = root.join("tests/fixtures/sample_mask.png");

    let image_bytes = std::fs::read(&sample_path).unwrap();
    let image = image_io::decode(&image_bytes).unwrap();
    let original_size = (image.width(), image.height());

    let u2netp = models::find_model("u2netp").unwrap();
    let tensor = pipeline::preprocess(u2netp, &image).unwrap();

    let mut session =
        inference::load_session_from_bytes(inference::U2NETP_MODEL_BYTES, "cpu").unwrap();
    let output = inference::run(&mut session, &tensor).unwrap();
    let alpha = pipeline::postprocess(u2netp, original_size, &output).unwrap();

    let rgb = image.to_rgb8();
    let output_bytes = image_io::encode_png_rgba(&rgb, &alpha).unwrap();
    let output_image = image_io::decode(&output_bytes).unwrap();
    assert!(
        output_image.color().has_alpha(),
        "output PNG must have an alpha channel"
    );

    let expected_mask_bytes = std::fs::read(&mask_path).unwrap();
    let expected_mask = image_io::decode(&expected_mask_bytes).unwrap().to_luma8();
    let predicted_mask = alpha;

    let (w, h) = predicted_mask.dimensions();
    assert_eq!(expected_mask.dimensions(), (w, h));

    let mut intersection = 0u64;
    let mut union = 0u64;
    for y in 0..h {
        for x in 0..w {
            let p = predicted_mask.get_pixel(x, y)[0] >= 128;
            let e = expected_mask.get_pixel(x, y)[0] >= 128;
            if p && e {
                intersection += 1;
            }
            if p || e {
                union += 1;
            }
        }
    }

    let iou = if union == 0 {
        1.0
    } else {
        intersection as f64 / union as f64
    };
    println!("IoU = {}", iou);
    assert!(iou >= 0.85, "IoU {} is below 0.85", iou);
}
