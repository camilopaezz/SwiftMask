use image::{DynamicImage, GrayImage, ImageFormat, RgbImage, RgbaImage};

use crate::error::AppError;

pub fn decode(bytes: &[u8]) -> Result<DynamicImage, AppError> {
    image::load_from_memory(bytes).map_err(|e| crate::error::image_decode_error(e.to_string()))
}

pub fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, AppError> {
    let mut buf = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut buf), ImageFormat::Png)
        .map_err(|e| crate::error::image_encode_error(e.to_string()))?;
    Ok(buf)
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
    let mut rgba = RgbaImage::new(w, h);
    for (x, y, pix) in rgb.enumerate_pixels() {
        let a = alpha.get_pixel(x, y)[0];
        rgba.put_pixel(x, y, image::Rgba([pix[0], pix[1], pix[2], a]));
    }
    let mut buf = Vec::new();
    rgba
        .write_to(&mut std::io::Cursor::new(&mut buf), ImageFormat::Png)
        .map_err(|e| crate::error::image_encode_error(e.to_string()))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_rgb() -> RgbImage {
        RgbImage::from_fn(32, 24, |x, y| {
            image::Rgb([x as u8, y as u8, (x + y) as u8])
        })
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
        rgb
            .write_to(&mut std::io::Cursor::new(&mut jpeg), ImageFormat::Jpeg)
            .unwrap();
        let decoded = decode(&jpeg).unwrap();
        assert_eq!(decoded.width(), 32);
        assert_eq!(decoded.height(), 24);
        let _png = encode_png(&decoded).unwrap();
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
        rgb
            .write_to(&mut std::io::Cursor::new(&mut bmp), ImageFormat::Bmp)
            .unwrap();
        let decoded = decode(&bmp).unwrap();
        assert_eq!(decoded.width(), 32);
        assert_eq!(decoded.height(), 24);
    }
}
