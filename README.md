# android-pntest-lab

Run the lab end-to-end with one command:

```bash
make up
```

This command:
- validates tool compatibility (`bash`, `docker`, `docker compose`, `adb`)
- starts the lab services
- verifies ADB access for device/emulator testing

## Commands

```bash
make check  # preflight compatibility checks only
make up     # start everything
make logs   # follow service logs
make down   # stop and clean up
```
