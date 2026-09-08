use crate::commands::daybook::{DaybookConfig, DaybookScheduleMode};
use crate::process_ext::HiddenCommandExt;
use std::path::PathBuf;
use std::process::Stdio;

const SERVICE_NAME: &str = "maestro-daybook.service";
const TIMER_NAME: &str = "maestro-daybook.timer";

fn unit_dir() -> Result<PathBuf, String> {
    let config = dirs::config_dir()
        .ok_or_else(|| "Could not locate the user configuration directory.".to_string())?;
    Ok(config.join("systemd/user"))
}

fn unit_path(name: &str) -> Result<PathBuf, String> {
    Ok(unit_dir()?.join(name))
}

pub fn installed() -> bool {
    unit_path(SERVICE_NAME).is_ok_and(|path| path.is_file())
        && unit_path(TIMER_NAME).is_ok_and(|path| path.is_file())
}

fn systemd_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn executable_path() -> Result<PathBuf, String> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| std::env::current_exe().ok())
        .ok_or_else(|| "Could not resolve Maestro's executable path.".to_string())
}

fn weekday_list(days: &[u8]) -> Result<String, String> {
    let names = days
        .iter()
        .map(|day| match day {
            1 => Ok("Mon"),
            2 => Ok("Tue"),
            3 => Ok("Wed"),
            4 => Ok("Thu"),
            5 => Ok("Fri"),
            6 => Ok("Sat"),
            7 => Ok("Sun"),
            _ => Err("Schedule contains an invalid weekday.".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if names.is_empty() {
        return Err("Choose at least one schedule day.".to_string());
    }
    Ok(names.join(","))
}

fn unit_contents(config: &DaybookConfig) -> Result<(String, String), String> {
    let executable = executable_path()?;
    let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_string());
    let service = format!(
        "[Unit]\nDescription=Write the Maestro Daybook entry\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nExecStart={} --daybook-run\nEnvironment={}\n",
        systemd_quote(&executable.to_string_lossy()),
        systemd_quote(&format!("PATH={path}")),
    );
    let timer_days = if config.schedule.mode == DaybookScheduleMode::AfterDayEnds {
        config
            .schedule
            .days
            .iter()
            .map(|day| if *day == 7 { 1 } else { day + 1 })
            .collect::<Vec<_>>()
    } else {
        config.schedule.days.clone()
    };
    let timer = format!(
        "[Unit]\nDescription=Run Maestro Daybook on schedule\n\n[Timer]\nOnCalendar={} *-*-* {}:00\nPersistent={}\nAccuracySec=1min\nUnit={}\n\n[Install]\nWantedBy=timers.target\n",
        weekday_list(&timer_days)?,
        config.schedule.time,
        if config.schedule.catch_up { "true" } else { "false" },
        SERVICE_NAME,
    );
    Ok((service, timer))
}

async fn systemctl(args: &[&str]) -> Result<String, String> {
    let mut command = tokio::process::Command::new("systemctl");
    command
        .arg("--user")
        .args(args)
        .stdin(Stdio::null())
        .hide_window();
    let output = command.output().await.map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        format!("systemctl --user {} failed.", args.join(" "))
    } else {
        detail
    })
}

pub async fn install(config: &DaybookConfig) -> Result<(), String> {
    let (service, timer) = unit_contents(config)?;
    let directory = unit_dir()?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    std::fs::write(directory.join(SERVICE_NAME), service).map_err(|error| error.to_string())?;
    std::fs::write(directory.join(TIMER_NAME), timer).map_err(|error| error.to_string())?;
    systemctl(&["daemon-reload"]).await?;
    systemctl(&["enable", "--now", TIMER_NAME]).await?;
    systemctl(&["is-enabled", TIMER_NAME]).await?;
    Ok(())
}

pub async fn uninstall() -> Result<(), String> {
    if !installed() {
        return Ok(());
    }
    // Disabling can fail when a unit was already inactive; local removal
    // is still the user's explicit request, so continue and reload.
    let _ = systemctl(&["disable", "--now", TIMER_NAME]).await;
    for name in [SERVICE_NAME, TIMER_NAME] {
        match std::fs::remove_file(unit_path(name)?) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    systemctl(&["daemon-reload"]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_iso_weekdays_to_systemd_calendar_names() {
        assert_eq!(weekday_list(&[1, 3, 7]).unwrap(), "Mon,Wed,Sun");
        assert!(weekday_list(&[]).is_err());
    }
}
