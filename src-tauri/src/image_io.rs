use image::{DynamicImage, GrayImage, ImageFormat, RgbImage, RgbaImage};

use crate::error::AppError;

pub fn decode(bytes: &[u8]) -> Result<DynamicImage, AppError> {
    image::load_from_memory(bytes).map_err(|e| crate::error::image_decode_error(e.to_string()))
}

pub fn encode_png_rgba(rgb: &RgbImage, alpha: &GrayImage) -> Result<Vec<u8>, AppError> {
    if rgb.dimensions() != alpha.dimensions() {
        return Err(crate::error::image_encode_error(format!(
            "rgb/alpha size mismatch: {:?} vs {:?}",
            rgb.dimensions(),
            alpha.dimensions()
        )));
    }
    let (w, h) = rgb.dimensions();
    // Interleave on raw buffers: per-pixel put_pixel/get_pixel bounds-checks
    // twice per pixel and was ~40 ms on a 12 MP image.
    let mut buf = Vec::with_capacity(w as usize * h as usize * 4);
    for (px, &a) in rgb.as_raw().as_chunks::<3>().0.iter().zip(alpha.as_raw()) {
        buf.extend_from_slice(&[px[0], px[1], px[2], a]);
    }
    let rgba = RgbaImage::from_raw(w, h, buf)
        .ok_or_else(|| crate::error::image_encode_error("rgba buffer size mismatch"))?;
    let mut buf = Vec::new();
    rgba.write_to(&mut std::io::Cursor::new(&mut buf), ImageFormat::Png)
        .map_err(|e| crate::error::image_encode_error(e.to_string()))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rgb() -> RgbImage {
        RgbImage::from_fn(32, 24, |x, y| image::Rgb([x as u8, y as u8, (x + y) as u8]))
    }

    #[test]
    fn png_round_trip() {
        let rgb = make_rgb();
        let alpha = GrayImage::from_fn(32, 24, |x, _| image::Luma([x as u8 * 8]));
        let png = encode_png_rgba(&rgb, &alpha).unwrap();
        let decoded = decode(&png).unwrap();
        assert_eq!(decoded.width(), 32);
        assert_eq!(decoded.height(), 24);
        let rgba = decoded.to_rgba8();
        assert_eq!(rgba.get_pixel(10, 5)[3], 80);
    }

    #[test]
    fn jpeg_decode_and_reencode_png() {
        let rgb = make_rgb();
        let mut jpeg = Vec::new();
        rgb.write_to(&mut std::io::Cursor::new(&mut jpeg), ImageFormat::Jpeg)
            .unwrap();
        let decoded = decode(&jpeg).unwrap();
        assert_eq!(decoded.width(), 32);
        assert_eq!(decoded.height(), 24);
        let alpha = GrayImage::from_fn(32, 24, |_, _| image::Luma([255]));
        let png = encode_png_rgba(&decoded.to_rgb8(), &alpha).unwrap();
        let round_trip = decode(&png).unwrap();
        assert_eq!(round_trip.width(), 32);
        assert_eq!(round_trip.height(), 24);
    }

    #[test]
    fn webp_round_trip() {
        let rgb = make_rgb();
        let mut webp = Vec::new();
        if rgb
            .write_to(&mut std::io::Cursor::new(&mut webp), ImageFormat::WebP)
            .is_ok()
        {
            let decoded = decode(&webp).unwrap();
            assert_eq!(decoded.width(), 32);
            assert_eq!(decoded.height(), 24);
        }
    }

    #[test]
    fn bmp_round_trip() {
        let rgb = make_rgb();
        let mut bmp = Vec::new();
        rgb.write_to(&mut std::io::Cursor::new(&mut bmp), ImageFormat::Bmp)
            .unwrap();
        let decoded = decode(&bmp).unwrap();
        assert_eq!(decoded.width(), 32);
        assert_eq!(decoded.height(), 24);
    }
}
