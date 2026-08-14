from app.remote_monitor import METRICS_SCRIPT, _parse_metrics


def test_metrics_script_preserves_fractional_cpu_usage_with_correct_second_sample_fields():
    assert 'printf "%.1f\\n"' in METRICS_SCRIPT
    assert "user2=$13" in METRICS_SCRIPT
    assert "idle2=$16" in METRICS_SCRIPT


def test_parse_metrics_keeps_cpu_fraction_and_disk_values():
    output = """===HOSTNAME===
server-a
===CPU_COUNT===
4
===CPU_PERCENT===
37.5
===MEMORY===
1024
512
512
===DISK===
10240 4096 6144 40%
===GPU===
N/A
"""

    metrics = _parse_metrics(output)

    assert metrics.cpu_count == 4
    assert metrics.cpu_percent == 37.5
    assert metrics.disk_total_mb == 10240
    assert metrics.disk_used_mb == 4096
    assert metrics.disk_percent == 40.0
