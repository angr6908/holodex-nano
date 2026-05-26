# Holodex Nano

## Demo site
https://holodex-nano.vercel.app

## Personalization
You may change the constants below for personalization.
|Constant|Location|Function|
|:--|:--|:--|
|`DEFAULT_HOME_ORGS`|`/src/lib/holodex.ts`|Loads these organizations by default|
|`preferredOrgNames`|`/src/lib/orgs.ts`|Organizations in the Quick Select zone|

## Deploy with Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/angr6908/holodex-nano)

## Deploy with Docker

```yaml
services:
  holodex-nano:
    image: unmol637/holodex-nano:latest
    container_name: holodex-nano
    restart: always
    ports:
      - "8080:8080"
```
