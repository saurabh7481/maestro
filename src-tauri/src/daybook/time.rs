use chrono::{DateTime, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayWindow {
    pub date: NaiveDate,
    pub timezone: Tz,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

fn resolve_local(timezone: Tz, date: NaiveDate, time: NaiveTime) -> Result<DateTime<Utc>, String> {
    let local = date.and_time(time);
    match timezone.from_local_datetime(&local) {
        LocalResult::Single(value) => Ok(value.with_timezone(&Utc)),
        // Midnight can be ambiguous in a small number of historical zones.
        // The earliest instant is the only choice that covers the full date.
        LocalResult::Ambiguous(first, second) => Ok(first.min(second).with_timezone(&Utc)),
        LocalResult::None => Err(format!(
            "The start of {date} does not exist in {timezone} because of a time-zone transition."
        )),
    }
}

pub fn parse_timezone(value: &str) -> Result<Tz, String> {
    value.trim().parse::<Tz>().map_err(|_| {
        format!("'{value}' is not a valid IANA time zone (for example, Asia/Kolkata).")
    })
}

pub fn detect_timezone() -> String {
    std::env::var("TZ")
        .ok()
        .filter(|value| value.parse::<Tz>().is_ok())
        .or_else(|| iana_time_zone::get_timezone().ok())
        .filter(|value| value.parse::<Tz>().is_ok())
        .unwrap_or_else(|| "UTC".to_string())
}

impl DayWindow {
    pub fn for_date(date: NaiveDate, timezone: Tz) -> Result<Self, String> {
        let next = date
            .succ_opt()
            .ok_or_else(|| "Date is outside the supported range.".to_string())?;
        let midnight = NaiveTime::from_hms_opt(0, 0, 0)
            .ok_or_else(|| "Could not construct midnight.".to_string())?;
        Ok(Self {
            date,
            timezone,
            start: resolve_local(timezone, date, midnight)?,
            end: resolve_local(timezone, next, midnight)?,
        })
    }

    pub fn from_configured_date(value: Option<&str>, timezone: Tz) -> Result<Self, String> {
        let today = Utc::now().with_timezone(&timezone).date_naive();
        let date = match value {
            Some(value) => NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map_err(|_| "Daybook date must use YYYY-MM-DD format.".to_string())?,
            None => today,
        };
        if date > today {
            return Err("Choose today or an earlier date in the configured time zone.".to_string());
        }
        Self::for_date(date, timezone)
    }

    pub fn contains_rfc3339(&self, value: &str) -> bool {
        DateTime::parse_from_rfc3339(value)
            .map(|timestamp| {
                let timestamp = timestamp.with_timezone(&Utc);
                timestamp >= self.start && timestamp < self.end
            })
            .unwrap_or(false)
    }

    pub fn is_today(&self) -> bool {
        Utc::now().with_timezone(&self.timezone).date_naive() == self.date
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_iana_timezones() {
        assert!(parse_timezone("Local time").is_err());
        assert_eq!(
            parse_timezone("Asia/Kolkata").unwrap(),
            chrono_tz::Asia::Kolkata
        );
    }

    #[test]
    fn day_windows_follow_dst() {
        let timezone = chrono_tz::America::New_York;
        let spring =
            DayWindow::for_date(NaiveDate::from_ymd_opt(2026, 3, 8).unwrap(), timezone).unwrap();
        let fall =
            DayWindow::for_date(NaiveDate::from_ymd_opt(2026, 11, 1).unwrap(), timezone).unwrap();
        assert_eq!((spring.end - spring.start).num_hours(), 23);
        assert_eq!((fall.end - fall.start).num_hours(), 25);
    }

    #[test]
    fn offset_timestamps_are_compared_as_instants() {
        let window = DayWindow::for_date(
            NaiveDate::from_ymd_opt(2026, 9, 8).unwrap(),
            chrono_tz::Asia::Kolkata,
        )
        .unwrap();
        assert!(window.contains_rfc3339("2026-09-07T18:30:00Z"));
        assert!(!window.contains_rfc3339("2026-09-08T18:30:00Z"));
    }
}
