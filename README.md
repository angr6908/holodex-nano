# Holodex Nano

## Deploy with Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/angr6908/holodex-nano)

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
