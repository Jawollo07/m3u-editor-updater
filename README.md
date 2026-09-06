# m3u-editor Updater

Autonomous Linux updater for a Docker Compose based [m3u-editor](https://github.com/m3ue/m3u-editor) installation.

The upstream project currently documents Docker Compose deployments using the `sparkison/m3u-editor:${IMAGE_TAG:-latest}` image and provides AIO and modular Compose examples. This updater intentionally operates on the existing Compose project instead of replacing its configuration.

## Features

- Automatic Docker Compose project discovery or explicit project path
- Pulls the newest configured m3u-editor image
- Creates a backup before changing the deployment
- Validates the Compose configuration
- Recreates the m3u-editor service
- Waits for the service to become healthy/running
- Captures the previous image ID for rollback
- Automatically rolls back after a failed update/health check
- Optional backup of `data` and `storage`
- Optional Discord-compatible webhook notifications
- Daily systemd timer
- Lock file prevents concurrent updater runs
- Dry-run mode
- Dangling-image cleanup
- No npm dependencies

## Requirements

- Linux
- Node.js 20+
- Docker Engine
- Docker Compose v2 (`docker compose`)
- Permission to access Docker and the Compose project

## Installation

```bash
sudo mkdir -p /opt/m3u-editor-updater/config
sudo git clone https://github.com/Jawollo07/m3u-editor-updater.git /opt/m3u-editor-updater
sudo cp /opt/m3u-editor-updater/config/config.example.json /opt/m3u-editor-updater/config/config.json
sudo nano /opt/m3u-editor-updater/config/config.json
```

Set `projectDir` to the directory containing your existing Compose file. If `composeFile` is omitted/empty, the updater checks the common Compose filenames.

Example:

```json
{
  "projectDir": "/opt/m3u-editor",
  "composeFile": "docker-compose.yml",
  "service": "m3u-editor"
}
```

Do **not** put passwords or IPTV credentials into this repository. Keep those in the existing `.env` used by m3u-editor.

## Test manually

```bash
cd /opt/m3u-editor-updater
sudo M3U_UPDATER_CONFIG=/opt/m3u-editor-updater/config/config.json node updater.js --dry-run
```

Then run a real update:

```bash
sudo M3U_UPDATER_CONFIG=/opt/m3u-editor-updater/config/config.json node updater.js
```

## systemd automation

```bash
sudo cp systemd/m3u-editor-updater.service /etc/systemd/system/
sudo cp systemd/m3u-editor-updater.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now m3u-editor-updater.timer
```

Check:

```bash
systemctl status m3u-editor-updater.timer
systemctl list-timers m3u-editor-updater.timer
journalctl -u m3u-editor-updater.service -n 200 --no-pager
```

The supplied timer runs daily at 04:15 with a randomized delay of up to 15 minutes.

## Backups and rollback

By default the updater stores Compose configuration and `.env` backups in:

```text
/var/backups/m3u-editor-updater/
```

Set `backup.includeData` to `true` if you also want `data/` and `storage/` archived. This can consume substantial disk space for large IPTV installations.

Rollback works by retaining the previous Docker image ID, restoring its tag, recreating the service and running the health check again. If the previous image is unavailable, the updater reports a critical rollback failure instead of pretending the rollback succeeded.

## Configuration

| Setting | Meaning |
|---|---|
| `projectDir` | Existing m3u-editor Compose directory |
| `composeFile` | Compose filename/path |
| `service` | Compose service to update |
| `health.enabled` | Enable post-update health verification |
| `health.timeoutSeconds` | Maximum health-check wait |
| `health.requireDockerHealthy` | Require Docker health status `healthy` |
| `backup.directory` | Backup destination |
| `backup.keep` | Number of backups to retain |
| `backup.includeData` | Archive `data/` and `storage/` |
| `notifications.webhookUrl` | Optional Discord-compatible webhook |
| `update.dryRun` | Validate without changing containers |

## Important m3u-editor details

The updater does not replace your Compose file. The official m3u-editor documentation currently shows the AIO deployment using a service named `m3u-editor` and the image `sparkison/m3u-editor:${IMAGE_TAG:-latest}`. Modular deployments use additional services such as PostgreSQL, Redis, m3u-proxy and a reverse proxy. Updating only the `m3u-editor` service avoids unnecessarily recreating unrelated infrastructure.

If your installation uses a pinned version instead of `latest`, the updater respects the image reference in your existing Compose configuration.

## Security

The updater executes Docker commands with the permissions of its systemd service. Run it as root only if required by your Docker setup. Never expose the updater's webhook URL or configuration containing secrets.

## License

MIT
