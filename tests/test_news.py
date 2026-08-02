from __future__ import annotations

import pandas as pd
import pytest

from propbt.config import PROJECT_ROOT
from propbt.data.news import NewsFormatError, filter_impact, load_news_events


def write_csv(tmp_path, name, content):
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    return path


def test_loads_canonical_columns(tmp_path):
    path = write_csv(tmp_path, "news.csv",
                      "timestamp_utc,event,impact\n"
                      "2025-03-11T18:00:00Z,FOMC Statement,High\n"
                      "2025-04-10T12:30:00Z,CPI,Medium\n")
    df = load_news_events(path)
    assert list(df.columns) == ["event", "impact"]
    assert isinstance(df.index, pd.DatetimeIndex)
    assert str(df.index.tz) == "UTC"
    assert df.iloc[0]["event"] == "FOMC Statement"
    assert df.iloc[0]["impact"] == "high"  # lowercased


def test_tolerates_alternate_column_names_and_order(tmp_path):
    path = write_csv(tmp_path, "news.csv",
                      "Importance,Date,Title\n"
                      "High,2025-03-11 18:00:00,FOMC Statement\n")
    df = load_news_events(path)
    assert df.iloc[0]["event"] == "FOMC Statement"
    assert df.iloc[0]["impact"] == "high"
    assert df.index[0] == pd.Timestamp("2025-03-11 18:00:00", tz="UTC")


def test_tolerates_whitespace_and_case_in_column_names(tmp_path):
    path = write_csv(tmp_path, "news.csv",
                      "  TIMESTAMP  , Event , IMPACT\n"
                      "2025-03-11T18:00:00Z,FOMC,High\n")
    df = load_news_events(path)
    assert len(df) == 1


def test_naive_timestamps_are_treated_as_utc(tmp_path):
    path = write_csv(tmp_path, "news.csv",
                      "timestamp,event,impact\n"
                      "2025-03-11 18:00:00,FOMC,High\n")
    df = load_news_events(path)
    assert df.index[0] == pd.Timestamp("2025-03-11 18:00:00", tz="UTC")


def test_missing_timestamp_column_raises(tmp_path):
    path = write_csv(tmp_path, "news.csv", "event,impact\nFOMC,High\n")
    with pytest.raises(NewsFormatError, match="timestamp"):
        load_news_events(path)


def test_missing_event_column_raises(tmp_path):
    path = write_csv(tmp_path, "news.csv", "timestamp,impact\n2025-03-11T18:00:00Z,High\n")
    with pytest.raises(NewsFormatError, match="event"):
        load_news_events(path)


def test_missing_impact_column_raises(tmp_path):
    path = write_csv(tmp_path, "news.csv", "timestamp,event\n2025-03-11T18:00:00Z,FOMC\n")
    with pytest.raises(NewsFormatError, match="impact"):
        load_news_events(path)


def test_unparseable_timestamp_raises(tmp_path):
    path = write_csv(tmp_path, "news.csv", "timestamp,event,impact\nnot-a-date,FOMC,High\n")
    with pytest.raises(NewsFormatError, match="unparseable"):
        load_news_events(path)


def test_duplicate_timestamps_raise(tmp_path):
    path = write_csv(tmp_path, "news.csv",
                      "timestamp,event,impact\n"
                      "2025-03-11T18:00:00Z,FOMC,High\n"
                      "2025-03-11T18:00:00Z,Other,Low\n")
    with pytest.raises(NewsFormatError, match="duplicate"):
        load_news_events(path)


def test_rows_sorted_by_timestamp(tmp_path):
    path = write_csv(tmp_path, "news.csv",
                      "timestamp,event,impact\n"
                      "2025-05-01T12:00:00Z,Second,High\n"
                      "2025-03-11T18:00:00Z,First,High\n")
    df = load_news_events(path)
    assert list(df["event"]) == ["First", "Second"]


def test_filter_impact_default_high_only(tmp_path):
    path = write_csv(tmp_path, "news.csv",
                      "timestamp,event,impact\n"
                      "2025-03-11T18:00:00Z,FOMC,High\n"
                      "2025-03-12T12:30:00Z,Retail Sales,Medium\n"
                      "2025-03-13T08:30:00Z,Housing Starts,Low\n")
    df = load_news_events(path)
    high = filter_impact(df)
    assert list(high["event"]) == ["FOMC"]


def test_filter_impact_custom_values(tmp_path):
    path = write_csv(tmp_path, "news.csv",
                      "timestamp,event,impact\n"
                      "2025-03-11T18:00:00Z,FOMC,High\n"
                      "2025-03-12T12:30:00Z,Retail Sales,Medium\n")
    both = filter_impact(load_news_events(path), impact_values=["high", "medium"])
    assert len(both) == 2


def test_real_news_events_csv_loads_cleanly():
    path = PROJECT_ROOT / "news_events.csv"
    if not path.exists():
        pytest.skip("news_events.csv not present")
    df = load_news_events(path)
    assert len(df) > 0
    assert (df["impact"] == "high").all()
    assert df.index.is_monotonic_increasing
    assert df.index.min().year == 2021
    assert df.index.max().year <= 2026
