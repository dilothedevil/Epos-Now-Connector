// Read-only Claude connector (MCP server) for the Epos Now REST API.
// One file, no dependencies. Runs as a Cloudflare Worker (paste this file into the
// Worker's code editor) or on any Node 20+ host via server.js.
//
// Secret settings (Render: Environment; Cloudflare: Worker > Settings > Variables and Secrets):
//   EPOSNOW_API_KEY     - API key from Epos Now Back Office (Web Integrations > REST API)
//   EPOSNOW_API_SECRET  - API secret from the same screen
//   CONNECTOR_KEY       - any long random password; it becomes part of the connector URL
//   EPOSNOW_BASE_URL    - optional, defaults to https://api.eposnowhq.com
//
// The connector URL is https://<your host>/<CONNECTOR_KEY>/mcp
// It only ever sends GET requests to Epos Now, so it cannot change anything on the till.

let ENV = {};

const SERVER_INFO = { name: "eposnow-readonly", version: "1.0.0" };
const PAGE_SIZE = 200; // Epos Now returns up to 200 rows per page
const MAX_PAGES = 400; // safety stop so a runaway loop can't burn the API allowance
const PARALLEL = 4;
const CACHE_MS = 10 * 60 * 1000;

const cache = new Map();

// ---------- Epos Now client ----------

function baseUrl() {
  return (ENV.EPOSNOW_BASE_URL || "https://api.eposnowhq.com").replace(/\/+$/, "");
}

function authHeader() {
  const key = ENV.EPOSNOW_API_KEY;
  const secret = ENV.EPOSNOW_API_SECRET;
  if (!key || !secret) throw new Error("EPOSNOW_API_KEY and EPOSNOW_API_SECRET are not set in the connector's secret settings.");
  return "Basic " + btoa(`${key.trim()}:${secret.trim()}`);
}

async function eposGet(path, params = {}) {
  const url = new URL(baseUrl() + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: "GET", headers: { Authorization: authHeader(), Accept: "application/json" } });
    } catch (err) {
      throw new Error(`Couldn't reach Epos Now at ${url.origin} (${err.message}).`);
    }
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error(`Epos Now refused the API key/secret (HTTP ${res.status}). Check them in the connector's secret settings.`);
      throw new Error(`Epos Now returned HTTP ${res.status} for ${url.pathname}${url.search}: ${text.slice(0, 300)}`);
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }
}

function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const k of ["Data", "data", "Items", "items", "Results", "results", "Value", "value"]) if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

// Fetches every page of a list endpoint, a few pages at a time.
async function eposGetAll(path, params = {}) {
  const all = [];
  for (let start = 1; start <= MAX_PAGES; start += PARALLEL) {
    const pages = [];
    for (let p = start; p < start + PARALLEL; p++) pages.push(eposGet(path, { ...params, page: p }).then(rowsOf));
    const results = await Promise.all(pages);
    let done = false;
    for (const rows of results) {
      if (done) break;
      all.push(...rows);
      if (rows.length < PAGE_SIZE) done = true;
    }
    if (done) return all;
  }
  return all;
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// Epos Now field names vary a little between API versions, so read them leniently.
function pick(obj, ...names) {
  if (!obj) return undefined;
  for (const n of names) if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  return undefined;
}
const num = (v) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? 0 : Number(v));
const money = (v) => Math.round(v * 100) / 100;

async function loadProducts() {
  return cached("products", async () => {
    const [rows, categories, suppliers] = await Promise.all([
      eposGetAll("/api/v4/Product"),
      eposGetAll("/api/v4/Category").catch(() => []),
      eposGetAll("/api/v4/Supplier").catch(() => []),
    ]);
    const catName = new Map(categories.map((c) => [pick(c, "Id", "CategoryId"), pick(c, "Name", "Description")]));
    const supName = new Map(suppliers.map((s) => [pick(s, "Id", "SupplierId"), pick(s, "Name", "SupplierName", "CompanyName")]));
    return rows.map((p) => {
      const categoryId = pick(p, "CategoryId", "CategoryID");
      const supplierId = pick(p, "SupplierId", "SupplierID", "PreferredSupplierId");
      return {
        id: pick(p, "Id", "ProductId", "ProductID"),
        name: pick(p, "Name", "Description") || "",
        barcode: pick(p, "Barcode", "BarCode") || "",
        sku: pick(p, "Sku", "SKU", "ProductCode", "OrderCode") || "",
        cost_price: num(pick(p, "CostPrice", "Cost")),
        sale_price: num(pick(p, "SalePrice", "Price", "EatOutPrice")),
        category: catName.get(categoryId) || (categoryId ?? ""),
        supplier: supName.get(supplierId) || (supplierId ?? ""),
        archived: Boolean(pick(p, "IsArchived", "Archived", "Deleted")),
      };
    });
  });
}

async function loadStock() {
  return cached("stock", async () => {
    const rows = await eposGetAll("/api/v4/ProductStock");
    const byProduct = new Map();
    for (const s of rows) {
      const id = pick(s, "ProductId", "ProductID");
      const cur = byProduct.get(id) || { current: 0, min: 0, max: 0, on_order: 0 };
      cur.current += num(pick(s, "CurrentStock", "CurrentVolume", "Quantity", "Stock"));
      cur.min += num(pick(s, "MinStock", "MinimumStock", "ReorderLevel"));
      cur.max += num(pick(s, "MaxStock", "MaximumStock"));
      cur.on_order += num(pick(s, "OnOrder", "OnOrderQuantity"));
      byProduct.set(id, cur);
    }
    return byProduct;
  });
}

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}
function parseDay(s, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) throw new Error(`${name} must look like 2026-10-24`);
  return s;
}

// Transactions are fetched a month at a time so no single request gets too big.
async function loadTransactions(startDate, endDate) {
  const out = [];
  let from = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  while (from <= end) {
    const to = new Date(Math.min(end.getTime(), from.getTime() + 30 * 86400000));
    const rows = await cached(`tx:${isoDay(from)}:${isoDay(to)}`, () =>
      eposGetAll("/api/v4/Transaction/GetByDate", { startDate: isoDay(from), endDate: isoDay(to) })
    );
    out.push(...rows);
    from = new Date(to.getTime() + 86400000);
  }
  // Drop held / ordered tickets; only completed sales (or rows with no status) count.
  const seen = new Set();
  return out.filter((t) => {
    const id = pick(t, "Id", "TransactionId");
    if (id !== undefined) {
      if (seen.has(id)) return false;
      seen.add(id);
    }
    const status = pick(t, "StatusId", "Status", "TransactionStatus");
    return status === undefined || status === 1 || status === "Completed" || status === "Complete";
  });
}

async function salesByProduct(startDate, endDate) {
  const [transactions, products] = await Promise.all([loadTransactions(startDate, endDate), loadProducts()]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const sales = new Map();
  let revenue = 0;
  for (const t of transactions) {
    for (const item of pick(t, "TransactionItems", "Items", "Products") || []) {
      const id = pick(item, "ProductId", "ProductID");
      const qty = num(pick(item, "Quantity", "Qty"));
      const unit = num(pick(item, "UnitPrice", "Price", "SalePrice"));
      const lineTotal = pick(item, "Total", "TotalPrice", "LineTotal", "Amount");
      const discount = num(pick(item, "DiscountAmount", "Discount"));
      const value = lineTotal !== undefined ? num(lineTotal) : qty * unit - discount;
      const row = sales.get(id) || { qty: 0, revenue: 0, transactions: 0 };
      row.qty += qty;
      row.revenue += value;
      row.transactions += 1;
      sales.set(id, row);
      revenue += value;
    }
  }
  return { transactions: transactions.length, revenue, sales, productById };
}

// ---------- Tools ----------

const TOOLS = [
  {
    name: "get_sales_by_product",
    description:
      "Sales from the Epos Now till for a date range, grouped by product: quantity sold, sales value (£, inc VAT as rung up), cost price, cost of goods and profit. Sorted best sellers first.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "First day, YYYY-MM-DD" },
        end_date: { type: "string", description: "Last day, YYYY-MM-DD" },
        search: { type: "string", description: "Optional text to filter product names, barcodes, category or supplier" },
        limit: { type: "integer", description: "Max rows to return (default 300)" },
      },
      required: ["start_date", "end_date"],
    },
    async run({ start_date, end_date, search, limit = 300 }) {
      parseDay(start_date, "start_date");
      parseDay(end_date, "end_date");
      const { transactions, revenue, sales, productById } = await salesByProduct(start_date, end_date);
      let rows = [...sales.entries()].map(([id, s]) => {
        const p = productById.get(id) || { name: `(unknown product ${id})`, cost_price: 0 };
        return {
          product_id: id,
          name: p.name,
          barcode: p.barcode,
          category: p.category,
          supplier: p.supplier,
          qty_sold: s.qty,
          sales_value: money(s.revenue),
          cost_price: p.cost_price,
          cost_of_goods: money(s.qty * p.cost_price),
          profit: money(s.revenue - s.qty * p.cost_price),
        };
      });
      rows = filterRows(rows, search).sort((a, b) => b.qty_sold - a.qty_sold);
      return {
        period: { start_date, end_date },
        transactions,
        total_sales_value: money(revenue),
        products_sold: rows.length,
        rows: rows.slice(0, limit),
        truncated: rows.length > limit,
      };
    },
  },
  {
    name: "get_stock_levels",
    description:
      "Current stock on hand for each product from Epos Now, with cost price, sale price, stock value at cost, min/max levels, category and supplier.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional text to filter product names, barcodes, category or supplier" },
        only: {
          type: "string",
          enum: ["all", "zero_or_negative", "below_min", "in_stock"],
          description: "Which products to include (default all)",
        },
        limit: { type: "integer", description: "Max rows to return (default 500)" },
        offset: { type: "integer", description: "Skip this many rows, for paging through long lists" },
      },
    },
    async run({ search, only = "all", limit = 500, offset = 0 }) {
      const [products, stock] = await Promise.all([loadProducts(), loadStock()]);
      let rows = products.map((p) => {
        const s = stock.get(p.id) || { current: 0, min: 0, max: 0, on_order: 0 };
        return {
          product_id: p.id,
          name: p.name,
          barcode: p.barcode,
          category: p.category,
          supplier: p.supplier,
          stock: s.current,
          min_stock: s.min,
          max_stock: s.max,
          on_order: s.on_order,
          cost_price: p.cost_price,
          sale_price: p.sale_price,
          stock_value_at_cost: money(Math.max(0, s.current) * p.cost_price),
          archived: p.archived,
        };
      });
      if (only === "zero_or_negative") rows = rows.filter((r) => r.stock <= 0 && !r.archived);
      if (only === "below_min") rows = rows.filter((r) => r.min_stock > 0 && r.stock < r.min_stock);
      if (only === "in_stock") rows = rows.filter((r) => r.stock > 0);
      rows = filterRows(rows, search).sort((a, b) => a.name.localeCompare(b.name));
      return {
        products: rows.length,
        total_stock_value_at_cost: money(rows.reduce((t, r) => t + r.stock_value_at_cost, 0)),
        rows: rows.slice(offset, offset + limit),
        next_offset: offset + limit < rows.length ? offset + limit : null,
      };
    },
  },
  {
    name: "get_reorder_report",
    description:
      "Combines current stock with sales over the last N days (default 90) to show, per product: stock, units sold, average weekly sales, weeks of stock left and a suggested order quantity to cover a target number of weeks. Also flags deadstock (stock but no sales).",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "How many days of sales to look back over (default 90)" },
        cover_weeks: { type: "number", description: "Weeks of stock to order up to (default 4)" },
        supplier: { type: "string", description: "Optional supplier name filter, e.g. Trust, Pedigree, Subridge" },
        search: { type: "string", description: "Optional text filter" },
        only: {
          type: "string",
          enum: ["all", "needs_order", "deadstock"],
          description: "needs_order = suggested order above 0; deadstock = in stock with no sales in the period",
        },
        limit: { type: "integer", description: "Max rows (default 500)" },
      },
    },
    async run({ days = 90, cover_weeks = 4, supplier, search, only = "all", limit = 500 }) {
      const end = new Date();
      const start = new Date(end.getTime() - (days - 1) * 86400000);
      const [{ sales }, products, stock] = await Promise.all([
        salesByProduct(isoDay(start), isoDay(end)),
        loadProducts(),
        loadStock(),
      ]);
      const weeks = days / 7;
      let rows = products
        .filter((p) => !p.archived)
        .map((p) => {
          const s = stock.get(p.id) || { current: 0, min: 0, on_order: 0 };
          const sold = sales.get(p.id)?.qty || 0;
          const perWeek = sold / weeks;
          const target = Math.ceil(perWeek * cover_weeks);
          const suggested = Math.max(0, target - Math.max(0, s.current) - s.on_order, s.min > 0 ? s.min - s.current - s.on_order : 0);
          return {
            product_id: p.id,
            name: p.name,
            barcode: p.barcode,
            supplier: p.supplier,
            category: p.category,
            stock: s.current,
            on_order: s.on_order,
            min_stock: s.min,
            sold_in_period: sold,
            avg_per_week: Math.round(perWeek * 10) / 10,
            weeks_of_stock: perWeek > 0 ? Math.round((Math.max(0, s.current) / perWeek) * 10) / 10 : null,
            suggested_order_qty: Math.ceil(suggested),
            cost_price: p.cost_price,
            order_cost: money(Math.ceil(suggested) * p.cost_price),
            deadstock: s.current > 0 && sold === 0,
          };
        });
      if (supplier) rows = rows.filter((r) => String(r.supplier).toLowerCase().includes(supplier.toLowerCase()));
      if (only === "needs_order") rows = rows.filter((r) => r.suggested_order_qty > 0);
      if (only === "deadstock") rows = rows.filter((r) => r.deadstock);
      rows = filterRows(rows, search).sort((a, b) => b.suggested_order_qty * b.cost_price - a.suggested_order_qty * a.cost_price || b.sold_in_period - a.sold_in_period);
      return {
        period: { start_date: isoDay(start), end_date: isoDay(end), days },
        cover_weeks,
        products: rows.length,
        total_order_cost: money(rows.reduce((t, r) => t + r.order_cost, 0)),
        rows: rows.slice(0, limit),
        truncated: rows.length > limit,
      };
    },
  },
  {
    name: "get_products",
    description: "The Epos Now product list: name, barcode, SKU, cost price, sale price, category and supplier.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional text filter" },
        limit: { type: "integer", description: "Max rows (default 500)" },
        offset: { type: "integer", description: "Skip this many rows, for paging" },
      },
    },
    async run({ search, limit = 500, offset = 0 }) {
      const rows = filterRows(await loadProducts(), search).sort((a, b) => a.name.localeCompare(b.name));
      return { products: rows.length, rows: rows.slice(offset, offset + limit), next_offset: offset + limit < rows.length ? offset + limit : null };
    },
  },
  {
    name: "eposnow_get",
    description:
      "Advanced: read any Epos Now API list or record directly (GET only, nothing is changed). Path must start with /api/v4/ or /api/v2/, e.g. /api/v4/Location or /api/v4/Supplier. Use when the other tools don't cover what's needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "API path, e.g. /api/v4/Supplier" },
        query: { type: "object", description: "Optional query parameters, e.g. {\"page\": 1}", additionalProperties: { type: ["string", "number"] } },
      },
      required: ["path"],
    },
    async run({ path, query = {} }) {
      if (!/^\/api\/v[24]\/[A-Za-z0-9/_-]+$/i.test(path || "")) throw new Error("path must look like /api/v4/Something");
      const data = await eposGet(path, query);
      const text = JSON.stringify(data);
      return text.length > 200000 ? { note: "Response cut to 200,000 characters; use paging.", data: text.slice(0, 200000) } : data;
    },
  },
];

function filterRows(rows, search) {
  if (!search) return rows;
  const q = String(search).toLowerCase();
  return rows.filter((r) => [r.name, r.barcode, r.sku, r.category, r.supplier].some((v) => v !== undefined && String(v).toLowerCase().includes(q)));
}

// ---------- MCP (JSON-RPC over Streamable HTTP) ----------

async function handleRpc(msg) {
  const { id, method, params = {} } = msg || {};
  const isNotification = id === undefined || id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Read-only access to the shop's Epos Now till data (in-store sales, stock, cost prices). Prices are in GBP. Use get_reorder_report for reordering and deadstock, get_sales_by_product for sales reports, get_stock_levels for stock.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params.name}`);
      try {
        const result = await tool.run(params.arguments || {});
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (err) {
        return reply({ content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
      }
    }
    default:
      if (method && method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${method}`);
  }
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function handle(request, env) {
  ENV = env || {};
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/([^/]+)\/mcp\/?$/);
  const expected = ENV.CONNECTOR_KEY || "";
  if (!match || expected.length < 16 || !safeEqual(decodeURIComponent(match[1]), expected)) return new Response("Not found", { status: 404 });

  if (request.method === "DELETE") return new Response(null, { status: 200 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(handleRpc))).filter(Boolean);
  if (replies.length === 0) return new Response(null, { status: 202 });
  return json(batch ? replies : replies[0]);
}

export default { fetch: handle };
