//! Label only this job's gnark containers so timeout/shutdown cleanup never targets others.
use crate::process;
use anyhow::{ensure, Context, Result};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub struct Scope {
    executable: PathBuf,
    label: String,
    environment: Vec<(OsString, OsString)>,
}

impl Scope {
    pub fn new(dir: &Path) -> Result<Self> {
        let original_path = std::env::var_os("PATH").context("PATH is missing")?;
        let executable = std::env::split_paths(&original_path)
            .map(|p| p.join("docker"))
            .find(|p| p.is_file())
            .context("Docker executable not found")?
            .canonicalize()?;
        Self::with_executable(dir, executable, original_path)
    }

    fn with_executable(dir: &Path, executable: PathBuf, original_path: OsString) -> Result<Self> {
        let label = format!(
            "mania.sp1.job={}",
            dir.file_name().context("missing job ID")?.to_string_lossy()
        );
        let tools = dir.join("tools");
        fs::create_dir_all(&tools)?;
        let wrapper = tools.join("docker");
        fs::write(&wrapper, b"#!/bin/sh\nset -eu\nif [ \"${1:-}\" = run ]; then\n  shift\n  exec \"$MANIA_DOCKER_BINARY\" run --label \"$MANIA_DOCKER_LABEL\" \"$@\"\nfi\nexec \"$MANIA_DOCKER_BINARY\" \"$@\"\n")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700))?;
        }
        let path = std::env::join_paths(
            std::iter::once(tools).chain(std::env::split_paths(&original_path)),
        )?;
        let environment = vec![
            ("PATH".into(), path),
            (
                "MANIA_DOCKER_BINARY".into(),
                executable.as_os_str().to_owned(),
            ),
            ("MANIA_DOCKER_LABEL".into(), label.clone().into()),
        ];
        Ok(Self {
            executable,
            label,
            environment,
        })
    }

    pub fn environment(&self) -> &[(OsString, OsString)] {
        &self.environment
    }

    pub async fn cleanup(&self) -> Result<()> {
        let stop = CancellationToken::new();
        let filter = format!("label={}", self.label);
        let ids = process::run(
            &self.executable,
            &["ps", "-aq", "--filter", &filter],
            Duration::from_secs(15),
            &stop,
            None,
        )
        .await?;
        let ids = String::from_utf8(ids)?;
        let ids: Vec<&str> = ids.split_whitespace().collect();
        if !ids.is_empty() {
            ensure!(
                ids.iter().all(|id| id.len() >= 12
                    && id.len() <= 64
                    && id.bytes().all(|b| b.is_ascii_hexdigit())),
                "invalid Docker container ID"
            );
            let args: Vec<&str> = ["rm", "-f"].into_iter().chain(ids).collect();
            process::run(
                &self.executable,
                &args,
                Duration::from_secs(15),
                &stop,
                None,
            )
            .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn wrapper_labels_runs_and_cleanup_targets_only_that_label() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let fake = root.path().join("fake-docker");
        fs::write(&fake, b"#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$(dirname \"$0\")/calls\"\nif [ \"$1\" = ps ]; then printf 'abcdef123456\\n'; fi\n").unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).unwrap();
        let scope =
            Scope::with_executable(root.path(), fake, std::env::var_os("PATH").unwrap()).unwrap();
        process::run_env(
            &root.path().join("tools/docker"),
            &["run", "--rm", "test-image"],
            Duration::from_secs(5),
            &CancellationToken::new(),
            None,
            scope.environment(),
        )
        .await
        .unwrap();
        scope.cleanup().await.unwrap();
        let calls = fs::read_to_string(root.path().join("calls")).unwrap();
        assert!(calls.contains(&format!("run\n--label\n{}\n--rm\ntest-image", scope.label)));
        assert!(calls.contains(&format!("ps\n-aq\n--filter\nlabel={}", scope.label)));
        assert!(calls.ends_with("rm\n-f\nabcdef123456\n"));
    }
}
