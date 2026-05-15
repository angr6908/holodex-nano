# Holodex Nano

## Sample `compose.yml`

```yaml
services:
  holodex-nano:
    image: unmol637/holodex-nano:latest
    container_name: holodex-nano
    restart: always
    ports:
      - "8080:8080"
```
