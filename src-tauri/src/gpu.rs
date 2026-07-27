use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::AppError;

const NVIDIA_VENDOR_ID: u32 = 0x10DE;
const AMD_VENDOR_ID: u32 = 0x1002;
const INTEL_VENDOR_ID: u32 = 0x8086;

/// VRAM threshold used for ONNX graph optimization level (Level3 if ≥ this).
pub const VRAM_LEVEL3_THRESHOLD: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    pub vendor: String,
    pub vram_bytes: Option<u64>,
    pub available_eps: Vec<String>,
    /// Display label, e.g. "Level1 (<4 GiB)" — matches session graph opt level.
    pub optimization: String,
}

/// Graph optimization level from VRAM: 3 if ≥4 GiB, else 1 (including unknown).
pub fn opt_level_for_vram(vram: Option<u64>) -> u8 {
    match vram {
        Some(bytes) if bytes >= VRAM_LEVEL3_THRESHOLD => 3,
        _ => 1,
    }
}

pub fn optimization_label(vram: Option<u64>) -> String {
    match vram {
        Some(bytes) if bytes >= VRAM_LEVEL3_THRESHOLD => "Level3 (≥4 GiB)".into(),
        Some(_) => "Level1 (<4 GiB)".into(),
        None => "Level1 (VRAM unknown)".into(),
    }
}

fn gpu_info(vendor: String, vram_bytes: Option<u64>, available_eps: Vec<String>) -> GpuInfo {
    GpuInfo {
        vendor,
        vram_bytes,
        available_eps,
        optimization: optimization_label(vram_bytes),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkResult {
    pub ep_latencies: Vec<EpLatency>,
    pub winner_ep: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpLatency {
    pub ep: String,
    pub seconds: f64,
}

pub fn detect_gpu() -> Result<GpuInfo, AppError> {
    #[cfg(target_os = "windows")]
    {
        detect_gpu_windows()
    }
    #[cfg(target_os = "linux")]
    {
        detect_gpu_linux()
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Ok(gpu_info("unknown".into(), None, vec![ep_cpu()]))
    }
}

#[cfg(target_os = "linux")]
fn detect_gpu_linux() -> Result<GpuInfo, AppError> {
    let nvidia_present = std::path::Path::new("/dev/nvidia0").exists()
        || std::path::Path::new("/dev/nvidiactl").exists();

    let mut info = run_lspci()
        .map(|output| parse_lspci(&output))
        .unwrap_or_else(|_| gpu_info("unknown".into(), None, vec![ep_cpu()]));

    if (nvidia_present || info.vendor == "NVIDIA") && !info.available_eps.contains(&ep_cuda()) {
        info.available_eps.insert(0, ep_cuda());
    }

    if nvidia_present || info.vendor == "NVIDIA" {
        if let Some(vram) = query_nvidia_vram() {
            info.vram_bytes = Some(vram);
            info.optimization = optimization_label(info.vram_bytes);
        }
    }

    Ok(info)
}

#[cfg(target_os = "linux")]
fn query_nvidia_vram() -> Option<u64> {
    let output = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mib: u64 = text.trim().lines().next()?.trim().parse().ok()?;
    Some(mib * 1024 * 1024)
}

#[cfg(target_os = "linux")]
fn run_lspci() -> Result<String, AppError> {
    let output = std::process::Command::new("lspci")
        .arg("-nn")
        .output()
        .map_err(|e| AppError::Gpu(format!("lspci not available: {}", e)))?;
    if !output.status.success() {
        return Err(AppError::Gpu("lspci failed".into()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(target_os = "linux")]
fn parse_lspci(output: &str) -> GpuInfo {
    let mut vendor_id = None;
    let mut vendor = None;

    for line in output.lines() {
        let lower = line.to_lowercase();
        if lower.contains("vga compatible controller") || lower.contains("3d controller") {
            for segment in line.split('[').skip(1) {
                if let Some(end) = segment.find(']') {
                    let content = segment[..end].split_whitespace().next().unwrap_or("");
                    if let Some(colon) = content.find(':') {
                        let left = &content[..colon];
                        let right = &content[colon + 1..];
                        if is_hex_4(left) && is_hex_4(right) {
                            if let Ok(vid) = u32::from_str_radix(left, 16) {
                                vendor_id = Some(vid);
                                vendor = Some(vid_to_vendor(vid));
                                break;
                            }
                        }
                    }
                }
            }
            break;
        }
    }

    let available_eps = if vendor_id == Some(NVIDIA_VENDOR_ID) {
        vec![ep_cuda(), ep_cpu()]
    } else {
        vec![ep_cpu()]
    };

    gpu_info(
        vendor.unwrap_or_else(|| "unknown".to_string()),
        None,
        available_eps,
    )
}

#[cfg(target_os = "linux")]
fn is_hex_4(s: &str) -> bool {
    s.len() == 4 && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn vid_to_vendor(vid: u32) -> String {
    match vid {
        NVIDIA_VENDOR_ID => "NVIDIA".into(),
        AMD_VENDOR_ID => "AMD".into(),
        INTEL_VENDOR_ID => "Intel".into(),
        _ => format!("0x{:04X}", vid),
    }
}

fn ep_cpu() -> String {
    "cpu".into()
}

fn ep_cuda() -> String {
    "cuda".into()
}

#[cfg(target_os = "windows")]
fn ep_directml() -> String {
    "directml".into()
}

// Not exported by windows 0.58 DXCore; GUID from DirectX-Headers (D3D12_GENERIC_ML).
#[cfg(target_os = "windows")]
const DXCORE_ADAPTER_ATTRIBUTE_D3D12_GENERIC_ML: windows::core::GUID =
    windows::core::GUID::from_u128(0xb71b0d41_1088_422f_a27c_0250b7d3a988);

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Debug, Clone, Copy)]
struct DxCoreAdapterCandidate {
    is_hardware: bool,
    supports_d3d12_graphics: bool,
    vendor_id: u32,
    dedicated_vram: u64,
}

/// Mirrors ORT DirectML default path: hardware GPU with D3D12 graphics support.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_directml_gpu_adapter(candidate: &DxCoreAdapterCandidate) -> bool {
    candidate.is_hardware && candidate.supports_d3d12_graphics
}

/// First adapter after DXCore HighPerformance sort that passes the DirectML GPU filter.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn select_directml_adapter(candidates: &[DxCoreAdapterCandidate]) -> Option<DxCoreAdapterCandidate> {
    candidates
        .iter()
        .copied()
        .find(is_directml_gpu_adapter)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn vram_bytes_from_dedicated(dedicated: u64) -> Option<u64> {
    if dedicated > 0 {
        Some(dedicated)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn read_dxcore_adapter_candidate(
    adapter: &windows::Win32::Graphics::DXCore::IDXCoreAdapter,
) -> Result<DxCoreAdapterCandidate, windows::core::Error> {
    use std::mem::size_of;

    use windows::Win32::Graphics::DXCore::{
        DedicatedAdapterMemory, DXCORE_ADAPTER_ATTRIBUTE_D3D12_GRAPHICS, DXCoreHardwareID,
        HardwareID, IsHardware,
    };

    unsafe {
        let mut is_hardware = false;
        adapter.GetProperty(
            IsHardware,
            size_of::<bool>(),
            &mut is_hardware as *mut _ as *mut _,
        )?;

        let supports_d3d12_graphics =
            adapter.IsAttributeSupported(&DXCORE_ADAPTER_ATTRIBUTE_D3D12_GRAPHICS);

        let mut hardware_id = DXCoreHardwareID::default();
        adapter.GetProperty(
            HardwareID,
            size_of::<DXCoreHardwareID>(),
            &mut hardware_id as *mut _ as *mut _,
        )?;

        let mut dedicated_vram = 0u64;
        adapter.GetProperty(
            DedicatedAdapterMemory,
            size_of::<u64>(),
            &mut dedicated_vram as *mut _ as *mut _,
        )?;

        Ok(DxCoreAdapterCandidate {
            is_hardware,
            supports_d3d12_graphics,
            vendor_id: hardware_id.vendorID,
            dedicated_vram,
        })
    }
}

#[cfg(target_os = "windows")]
fn query_dxcore_directml_adapter() -> Option<DxCoreAdapterCandidate> {
    use windows::Win32::Graphics::DXCore::{
        DXCORE_ADAPTER_ATTRIBUTE_D3D12_CORE_COMPUTE, DXCoreCreateAdapterFactory, HighPerformance,
        IDXCoreAdapter, IDXCoreAdapterFactory, IDXCoreAdapterList,
    };

    unsafe {
        let factory: IDXCoreAdapterFactory = match DXCoreCreateAdapterFactory() {
            Ok(factory) => factory,
            Err(e) => {
                log::warn!("DXCoreCreateAdapterFactory failed: {e}");
                return None;
            }
        };

        // GENERIC_ML first (ORT DML2); on empty list or HRESULT, fall through to CORE_COMPUTE.
        let adapter_list: IDXCoreAdapterList = match factory
            .CreateAdapterList::<IDXCoreAdapterList>(&[DXCORE_ADAPTER_ATTRIBUTE_D3D12_GENERIC_ML])
        {
            Ok(list) if list.GetAdapterCount() > 0 => list,
            generic_result => {
                if let Err(e) = generic_result {
                    log::warn!(
                        "DXCore CreateAdapterList (GENERIC_ML) failed: {e}; trying CORE_COMPUTE"
                    );
                }
                match factory
                    .CreateAdapterList::<IDXCoreAdapterList>(&[
                        DXCORE_ADAPTER_ATTRIBUTE_D3D12_CORE_COMPUTE,
                    ]) {
                    Ok(list) => list,
                    Err(e) => {
                        log::warn!("DXCore CreateAdapterList (CORE_COMPUTE) failed: {e}");
                        return None;
                    }
                }
            }
        };

        let count = adapter_list.GetAdapterCount();
        if count == 0 {
            log::warn!("DXCore: no adapters found");
            return None;
        }

        // Match ORT: skip sort for a single adapter; on failure keep factory order.
        if count > 1 {
            if let Err(e) = adapter_list.Sort(&[HighPerformance]) {
                log::warn!(
                    "DXCore adapter list Sort failed: {e}; continuing with unsorted list"
                );
            }
        }

        let mut candidates = Vec::with_capacity(count as usize);
        for index in 0..count {
            let adapter = match adapter_list.GetAdapter::<IDXCoreAdapter>(index) {
                Ok(adapter) => adapter,
                Err(e) => {
                    log::warn!("DXCore GetAdapter failed for adapter {index}: {e}");
                    continue;
                }
            };

            match read_dxcore_adapter_candidate(&adapter) {
                Ok(candidate) => candidates.push(candidate),
                Err(e) => {
                    log::warn!("DXCore adapter {index} property read failed: {e}");
                }
            }
        }

        select_directml_adapter(&candidates)
    }
}

#[cfg(target_os = "windows")]
fn detect_gpu_windows() -> Result<GpuInfo, AppError> {
    let (vendor, vram_bytes) = match query_dxcore_directml_adapter() {
        Some(best) => (
            vid_to_vendor(best.vendor_id),
            vram_bytes_from_dedicated(best.dedicated_vram),
        ),
        None => {
            log::warn!("DXCore GPU detection unavailable; reporting unknown vendor/VRAM");
            ("unknown".into(), None)
        }
    };
    let available_eps = vec![ep_directml(), ep_cpu()];

    Ok(gpu_info(vendor, vram_bytes, available_eps))
}

pub fn run_benchmark(app: &AppHandle) -> Result<BenchmarkResult, AppError> {
    let gpu_info = detect_gpu()?;
    let available_eps = gpu_info.available_eps;

    let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        64,
        64,
        image::Rgb([128, 128, 128]),
    ));
    let original_size = (64, 64);

    let u2netp = crate::models::find_model("u2netp")?;
    let tensor = crate::pipeline::preprocess(u2netp, &img)?;

    let mut ep_latencies = Vec::new();
    // If the requested EP runtime is not installed, ORT silently falls back to CPU.
    for ep in available_eps {
        let seconds = crate::inference::with_session(
            "u2netp",
            &ep,
            || Ok(crate::inference::U2NETP_MODEL_BYTES.to_vec()),
            |session| {
                let _warmup = crate::inference::run(session, &tensor)?;
                let _warmup_alpha = crate::pipeline::postprocess("u2netp", original_size, &_warmup)?;
                let start = Instant::now();
                let output = crate::inference::run(session, &tensor)?;
                let _alpha = crate::pipeline::postprocess("u2netp", original_size, &output)?;
                Ok(start.elapsed().as_secs_f64())
            },
        )?;
        ep_latencies.push(EpLatency {
            ep: ep.clone(),
            seconds,
        });
    }

    let winner = ep_latencies
        .iter()
        .min_by(|a, b| a.seconds.partial_cmp(&b.seconds).unwrap_or(std::cmp::Ordering::Equal))
        .map(|l| l.ep.clone())
        .unwrap_or_else(ep_cpu);

    persist_ep(app, &winner)?;

    Ok(BenchmarkResult {
        ep_latencies,
        winner_ep: winner,
    })
}

fn persist_ep(app: &AppHandle, ep: &str) -> Result<(), AppError> {
    let normalized = ep.to_lowercase();
    let mut config = crate::config::load_config(app)?;
    config.execution_provider = Some(normalized);
    crate::config::save_config(app, &config)?;
    crate::inference::invalidate_all_sessions()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "linux")]
    fn parse_lspci_amd_returns_cpu_only() {
        let output =
            "01:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] [1002:1638] (rev c1)\n";
        let info = parse_lspci(output);
        assert_eq!(info.vendor, "AMD");
        assert_eq!(info.available_eps, vec!["cpu"]);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn parse_lspci_nvidia_returns_cuda_and_cpu() {
        let output = "00:01.0 3D controller [0302]: NVIDIA Corporation [10de:1c20] (rev a1)\n";
        let info = parse_lspci(output);
        assert_eq!(info.vendor, "NVIDIA");
        assert_eq!(info.available_eps, vec!["cuda", "cpu"]);
    }

    #[test]
    fn is_directml_gpu_adapter_requires_hardware_and_graphics() {
        assert!(!is_directml_gpu_adapter(&DxCoreAdapterCandidate {
            is_hardware: false,
            supports_d3d12_graphics: true,
            vendor_id: NVIDIA_VENDOR_ID,
            dedicated_vram: 8 * 1024 * 1024 * 1024,
        }));
        assert!(!is_directml_gpu_adapter(&DxCoreAdapterCandidate {
            is_hardware: true,
            supports_d3d12_graphics: false,
            vendor_id: 0,
            dedicated_vram: 0,
        }));
        assert!(is_directml_gpu_adapter(&DxCoreAdapterCandidate {
            is_hardware: true,
            supports_d3d12_graphics: true,
            vendor_id: NVIDIA_VENDOR_ID,
            dedicated_vram: 8 * 1024 * 1024 * 1024,
        }));
    }

    #[test]
    fn select_directml_adapter_picks_first_sorted_gpu_not_max_vram() {
        let candidates = [
            DxCoreAdapterCandidate {
                is_hardware: false,
                supports_d3d12_graphics: true,
                vendor_id: INTEL_VENDOR_ID,
                dedicated_vram: 0,
            },
            DxCoreAdapterCandidate {
                is_hardware: true,
                supports_d3d12_graphics: false,
                vendor_id: 0,
                dedicated_vram: 0,
            },
            DxCoreAdapterCandidate {
                is_hardware: true,
                supports_d3d12_graphics: true,
                vendor_id: NVIDIA_VENDOR_ID,
                dedicated_vram: 8 * 1024 * 1024 * 1024,
            },
            DxCoreAdapterCandidate {
                is_hardware: true,
                supports_d3d12_graphics: true,
                vendor_id: AMD_VENDOR_ID,
                dedicated_vram: 16 * 1024 * 1024 * 1024,
            },
        ];
        let best = select_directml_adapter(&candidates).unwrap();
        assert_eq!(best.vendor_id, NVIDIA_VENDOR_ID);
        assert_eq!(best.dedicated_vram, 8 * 1024 * 1024 * 1024);
    }

    #[test]
    fn select_directml_adapter_returns_none_for_empty() {
        assert!(select_directml_adapter(&[]).is_none());
    }

    #[test]
    fn select_directml_adapter_accepts_zero_dedicated_vram_igpu() {
        let candidates = [DxCoreAdapterCandidate {
            is_hardware: true,
            supports_d3d12_graphics: true,
            vendor_id: INTEL_VENDOR_ID,
            dedicated_vram: 0,
        }];
        let best = select_directml_adapter(&candidates).unwrap();
        assert_eq!(best.vendor_id, INTEL_VENDOR_ID);
        assert_eq!(vram_bytes_from_dedicated(best.dedicated_vram), None);
    }

    #[test]
    fn vram_bytes_from_dedicated_returns_none_for_zero() {
        assert_eq!(vram_bytes_from_dedicated(0), None);
        assert_eq!(
            vram_bytes_from_dedicated(8 * 1024 * 1024 * 1024),
            Some(8 * 1024 * 1024 * 1024)
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn parse_lspci_missing_returns_unknown_cpu() {
        let info = parse_lspci("Ethernet controller [0200]: Realtek Semiconductor Co., Ltd.\n");
        assert_eq!(info.vendor, "unknown");
        assert_eq!(info.available_eps, vec!["cpu"]);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn benchmark_runs_on_available_eps() {
        let info = detect_gpu().unwrap();
        let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            64,
            64,
            image::Rgb([128, 128, 128]),
        ));
        let u2netp = crate::models::find_model("u2netp").unwrap();
        let tensor = crate::pipeline::preprocess(u2netp, &img).unwrap();

        for ep in &info.available_eps {
            let mut session =
                crate::inference::load_session_from_bytes(crate::inference::U2NETP_MODEL_BYTES, ep)
                    .unwrap();
            let _warmup = crate::inference::run(&mut session, &tensor).unwrap();
            let _warmup_alpha = crate::pipeline::postprocess("u2netp", (64, 64), &_warmup).unwrap();
            let start = Instant::now();
            let output = crate::inference::run(&mut session, &tensor).unwrap();
            let _alpha = crate::pipeline::postprocess("u2netp", (64, 64), &output).unwrap();
            println!("benchmark {}: {}s", ep, start.elapsed().as_secs_f64());
        }
    }
}
