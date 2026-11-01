# Status configuration

Status settings are read from `config.json` at the installed package root. If that file is absent, `config.json.example` supplies the defaults:

```json
{
  "status": {
    "enabled": true,
    "quietThresholdMs": 120000
  }
}
```

`PI_SUBAGENT_QUIET_THRESHOLD_MS` overrides the quiet threshold for the current process. It must be a positive integer. Package updates may replace changes made inside the installed package directory.
