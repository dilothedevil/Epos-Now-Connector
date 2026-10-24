# Epos Now connector for Claude (read-only)

Lets Claude read Pets N Plants' Epos Now till data: sales by product, stock levels,
cost prices and a reorder / deadstock report. It only sends GET requests to Epos Now,
so it can't change anything on the till.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dilothedevil/Epos-Now-Connector)

## Setup

1. Click **Deploy to Render** above and sign in with GitHub (free plan).
2. Paste your Epos Now **API Key** and **API Secret** (Back Office > Web Integrations > REST API >
   your device > Access Credentials) into `EPOSNOW_API_KEY` and `EPOSNOW_API_SECRET`.
   `CONNECTOR_KEY` is generated for you.
3. When the service is Live, open **Logs** and copy the line *Your Claude connector link*.
4. In claude.ai: Settings > Connectors > Add custom connector, and paste that link.

Keep the API secret and the connector link private.

## Files

- `worker.js` – the whole connector (MCP server, no dependencies).
- `server.js` – runs it as a Node web server on Render; keeps the free service awake.
- `render.yaml` – Render Blueprint used by the Deploy button.

Tools: `get_sales_by_product`, `get_stock_levels`, `get_reorder_report`, `get_products`,
`eposnow_get` (read any `/api/v4/...` path).
