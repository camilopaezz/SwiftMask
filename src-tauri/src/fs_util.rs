use std::io::{self, Write};
use std::path::Path;

/// Write `bytes` to `path` via a sibling `.tmp` file, then rename into place.
///
/// Unix rename replaces the destination atomically. When rename cannot replace
/// (Windows), the existing file is moved aside and restored if the new name
/// cannot be installed. The previous bytes are never deleted first.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    // A crash between move-aside and install leaves the previous bytes in the
    // backup and no live file. Put them back before replacing.
    recover_replaced(path)?;
    let tmp = tmp_path(path);
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
        file.sync_all()?;
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) if path.exists() => replace_via_backup(&tmp, path),
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            Err(err)
        }
    }
}

/// Dest exists and rename-over failed. Move it aside, then install `tmp`.
/// If the install fails, put the previous file back.
fn replace_via_backup(tmp: &Path, path: &Path) -> io::Result<()> {
    let bak = backup_path(path);
    // Leftover from a finished replace whose unlink failed. Dest still holds
    // the live bytes, so dropping this sibling does not lose them.
    if bak.exists() {
        std::fs::remove_file(&bak)?;
    }
    std::fs::rename(path, &bak)?;
    match std::fs::rename(tmp, path) {
        Ok(()) => {
            let _ = std::fs::remove_file(&bak);
            Ok(())
        }
        Err(err) => match std::fs::rename(&bak, path) {
            Ok(()) => {
                let _ = std::fs::remove_file(tmp);
                Err(err)
            }
            Err(restore_err) => Err(io::Error::new(
                restore_err.kind(),
                format!(
                    "replace failed ({err}); previous file left at {}",
                    bak.display()
                ),
            )),
        },
    }
}

/// If a replace crashed after moving the live file aside, put it back.
pub fn recover_replaced(path: &Path) -> io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    let bak = backup_path(path);
    if bak.exists() {
        std::fs::rename(&bak, path)?;
    }
    Ok(())
}

fn tmp_path(path: &Path) -> std::path::PathBuf {
    sibling(path, "tmp")
}

fn backup_path(path: &Path) -> std::path::PathBuf {
    // Not `{name}.bak`: config quarantine already uses `config.json.bak`.
    sibling(path, "old")
}

fn sibling(path: &Path, suffix: &str) -> std::path::PathBuf {
    match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => path.with_file_name(format!("{name}.{suffix}")),
        None => path.with_extension(suffix),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_creates_and_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.bin");
        write_atomic(&path, b"one").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"one");
        write_atomic(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert!(!tmp_path(&path).exists());
        assert!(!backup_path(&path).exists());
    }

    #[test]
    fn replace_via_backup_installs_new_and_drops_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.bin");
        std::fs::write(&path, b"old").unwrap();
        let tmp = tmp_path(&path);
        std::fs::write(&tmp, b"new").unwrap();

        replace_via_backup(&tmp, &path).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert!(!tmp.exists());
        assert!(!backup_path(&path).exists());
    }

    #[test]
    fn replace_via_backup_restores_dest_when_install_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.bin");
        std::fs::write(&path, b"old").unwrap();
        let tmp = tmp_path(&path);

        let err = replace_via_backup(&tmp, &path).unwrap_err();

        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        assert!(!backup_path(&path).exists());
        assert!(!err.to_string().contains("previous file left at"));
    }

    #[test]
    fn write_atomic_recovers_stranded_backup_before_replace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.bin");
        std::fs::write(backup_path(&path), b"old").unwrap();

        write_atomic(&path, b"new").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert!(!backup_path(&path).exists());
    }
}
