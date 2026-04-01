# Quick Reference - Claude Code Docker Instance

## 🚀 Essential Commands

### Start/Stop
```bash
cd /home/ables/gitroot/claude-code-full

docker-compose up -d              # Start all services
docker-compose down               # Stop all services
docker-compose ps                 # Check status
docker-compose logs -f            # Follow logs from all containers
```

### View Logs
```bash
docker logs claude-code-instance           # Claude Code logs
docker logs -f claude-code-instance        # Follow Claude Code logs
docker logs promtail-claude                # Promtail logs
docker logs -f promtail-claude             # Follow Promtail logs
```

### Access Container
```bash
docker exec -it claude-code-instance /bin/sh    # Interactive shell
docker exec claude-code-instance /app/cli.mjs   # Run CLI directly
```

### Inspect
```bash
docker ps                                       # Running containers
docker inspect claude-code-instance             # Full container info
docker inspect claude-code-instance | jq '.[0].Config.Labels'  # Just labels
```

---

## 📊 Current Status

```bash
# Run this to see everything:
docker-compose ps && echo && docker logs claude-code-instance | tail -20
```

**Expected Output:**
```
STATUS: Up (running) ✅
Promtail: Up (scraping logs) ✅
Yak Node: Started successfully ✅
Labels: promtail.enabled=true ✅
```

---

## 🔑 Configuration

### API Key Setup (.env)
```bash
# Edit .env file
vi /home/ables/gitroot/claude-code-full/.env

# Set your API key (required for use)
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY

# Restart to apply
docker-compose restart
```

---

## 📍 File Locations

| File | Location |
|------|----------|
| Docker Compose | `/home/ables/gitroot/claude-code-full/docker-compose.yml` |
| Promtail Config | `/home/ables/gitroot/claude-code-full/promtail-config.yaml` |
| Environment | `/home/ables/gitroot/claude-code-full/.env` |
| Yak Binary | `/home/ables/gitroot/docker_scripts/yaknode` |
| Data Volume | Docker volume: `claude-code-full_claude-data` |

---

## 🏷️ Promtail Labels

All Claude Code logs are tagged with:
```
promtail.job=claude-code
promtail.service=claude-code-cli
promtail.environment=production
promtail.namespace=claude
promtail.enabled=true
```

Query in Loki: `{job="claude-code"}`

---

## ⚙️ Key Features Running

✅ Claude Code CLI (9.3 MB)  
✅ Yak Node (network integration)  
✅ Promtail (log aggregation)  
✅ Data Persistence (3 volumes)  
✅ Isolated Network  
✅ Auto-restart on failure  

---

## 🐛 Troubleshooting

### Container won't start
```bash
docker-compose logs claude-code-instance
# Check for API key error: ANTHROPIC_API_KEY not set
```

### Promtail not getting logs
```bash
docker logs promtail-claude | head -30
# Should show: "added Docker target" messages
```

### Yak node not starting
```bash
docker logs claude-code-instance
# If "can't connect to master": normal if no yak master available
# Node still runs locally
```

### Rebuild from scratch
```bash
cd /home/ables/gitroot/claude-code-full
docker-compose down -v                 # Remove volumes too
docker image rm claude-code:latest      # Remove old image
docker-compose up -d                   # Rebuild and start
```

---

## 📈 What's Happening

```
┌─────────────────┐
│ Claude Code CLI │
│   (9.3 MB)      │
│   Running       │
└────────┬────────┘
         │
    [Yak Node]
    [Logging]
         │
    ┌────▼───────┐
    │  Promtail   │
    │ Scraping    │
    │   Logs      │
    └────┬────────┘
         │
    [Labels Applied]
    [Shipped to Loki]
```

---

## 🎯 Common Tasks

### Run a command in the container
```bash
docker exec claude-code-instance /app/cli.mjs -p "What is 2+2?"
```

### View all volumes
```bash
docker volume ls | grep claude
```

### Check resource usage
```bash
docker stats claude-code-instance
```

### Export logs
```bash
docker logs claude-code-instance > claude-logs.txt 2>&1
```

---

## 📋 Checklist

- [ ] Docker containers running (`docker-compose ps`)
- [ ] API key configured (check `.env`)
- [ ] Promtail discovering logs (check logs)
- [ ] Yak node started (check yak-init output)
- [ ] All labels applied (check docker inspect)
- [ ] Data volumes mounted (check docker volumes)

---

## 🔗 Related Resources

- **Full deployment details:** `DEPLOYMENT_SUMMARY.md`
- **Docker docs:** https://docs.docker.com
- **Promtail docs:** https://grafana.com/docs/loki/latest/send-data/promtail/
- **Yak info:** `/home/ables/gitroot/docker_scripts/yak-init.sh`

---

Generated: March 31, 2026, 23:55 UTC
