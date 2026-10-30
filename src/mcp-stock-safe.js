// 股票行情 MCP server（stdio，只读，无 key、无账号、不落盘）。
//
// 为什么单独做一个：QQ 侧的仿真会话没有本地执行能力（见 qq-tool-restrict.mjs 的 L7），
// 而主人希望她在 QQ 里也能聊股票行情。这里只暴露**只读查询**，数据来自公开接口：
//   · 腾讯行情   qt.gtimg.cn         —— 实时快照（A股/指数，GBK 编码）
//   · 东方财富   searchapi / push2his —— 代码搜索、日K
// 不接交易、不读本地文件、不接受任意 URL（防 SSRF：所有请求的 host 都是写死的）。
//
// 工具：
//   stock_search  按名称/拼音/代码查股票（返回 代码/名称/市场）
//   stock_quote   单只股票或指数的实时快照（价格、涨跌、成交额、市值、PE/PB…）
//   stock_kline   日 K 线（最近 N 个交易日）
//   stock_index   常见指数一览（上证/深成/创业板/科创50/北证50）
//
// 说明：数据是第三方公开行情，可能延迟或缺失；不要把这里的数字当交易依据。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) surfcore-stock-mcp';
const TIMEOUT_MS = 12000;

const server = new McpServer({ name: 'stock-safe', version: '1.0.0' });

/** 统一的取文本：带超时、带 UA，只接受 http(s)。 */
async function fetchText(url, encoding = 'utf-8') {
  if (!/^https:\/\//i.test(String(url))) throw new Error('只允许 https 请求');
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function fetchJson(url) {
  return fetchText(url, 'utf-8').then((t) => JSON.parse(t));
}

/**
 * 归一化标的：接受 600519 / 600519.SH / sh600519 / SH600519 / 中文名。
 * 返回 { code, market: 'sh'|'sz'|'bj', name? }。
 */
async function resolveSymbol(raw) {
  const input = String(raw ?? '').trim();
  if (!input) throw new Error('股票代码/名称不能为空');

  let m = /^(sh|sz|bj)(\d{6})$/i.exec(input);
  if (m) return { code: m[2], market: m[1].toLowerCase() };

  m = /^(\d{6})(?:\.(SH|SZ|BJ))?$/i.exec(input);
  if (m) {
    const code = m[1];
    const suffix = (m[2] || '').toLowerCase();
    const market = suffix || (code.startsWith('6') ? 'sh' : code.startsWith('4') || code.startsWith('8') ? 'bj' : 'sz');
    return { code, market };
  }

  // 名称/拼音：走东方财富搜索，取第一条“股票”结果
  const found = await stockSearch(input, 5);
  const hit = found.find((x) => x.code) || found[0];
  if (!hit) throw new Error(`没搜到「${input}」对应的股票`);
  return { code: hit.code, market: hit.market, name: hit.name };
}

function tencentSymbol(sym) {
  return `${sym.market}${sym.code}`;
}

function parseTencentQuote(text) {
  // v_sh600519="1~贵州茅台~600519~1354.00~...";
  const m = /="([^"]+)"/.exec(text);
  if (!m) throw new Error('行情接口返回格式异常');
  const f = m[1].split('~');
  if (f.length < 40) throw new Error('行情接口返回字段不足（可能是无效代码）');
  const num = (i) => {
    const v = Number(f[i]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    name: f[1] || '',
    code: f[2] || '',
    price: num(3),
    prevClose: num(4),
    open: num(5),
    change: num(31),
    changePct: num(32),
    high: num(33),
    low: num(34),
    volumeHand: num(36),
    amountWan: num(37),
    turnoverPct: num(38),
    peTtm: num(39),
    amplitudePct: num(43),
    floatCapYi: num(44),
    totalCapYi: num(45),
    pb: num(46),
    limitUp: num(47),
    limitDown: num(48),
    time: f[30] || '',
  };
}

async function stockSearch(keyword, count = 8) {
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=${Math.min(20, Math.max(1, count))}`;
  const data = await fetchJson(url);
  const rows = data?.QuotationCodeTable?.Data ?? [];
  return rows
    .filter((r) => r && r.Code)
    .map((r) => ({
      code: String(r.Code),
      name: String(r.Name ?? ''),
      market: r.JYS === '1' ? 'sh' : r.JYS === '2' ? 'sz' : 'bj',
      marketText: String(r.SecurityTypeName ?? ''),
      type: String(r.Classify ?? ''),
    }));
}

server.tool(
  'stock_search',
  '按股票名称/拼音/代码搜索 A 股标的，返回代码、名称、市场（sh/sz/bj）。用于「贵州茅台」「茅台」「GZMT」「600519」这类输入先确定代码。',
  {
    keyword: z.string().describe('股票名称、拼音缩写或代码片段，例如「茅台」「600519」'),
    count: z.number().optional().describe('返回条数，1~20，默认 8'),
  },
  async ({ keyword, count }) => {
    try {
      const rows = await stockSearch(keyword, count ?? 8);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, keyword, results: rows }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'stock_quote',
  '查一只 A 股或指数的实时快照（价格、涨跌额与幅度、开高低、成交量额、换手率、PE/PB、总市值/流通市值、涨跌停价、行情时间）。数据来自腾讯公开行情，可能延迟几分钟；只读，不能交易。',
  {
    symbol: z.string().describe('代码或名称：600519 / 600519.SH / sh000001 / 茅台'),
  },
  async ({ symbol }) => {
    try {
      const sym = await resolveSymbol(symbol);
      const text = await fetchText(`https://qt.gtimg.cn/q=${tencentSymbol(sym)}`, 'gbk');
      const quote = parseTencentQuote(text);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: true, market: sym.market, ...quote }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `查行情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'stock_kline',
  '查日 K 线（最近 N 个交易日，默认 60，最多 250）。返回日期、开、收、高、低、成交量、成交额、振幅。适合看趋势/近期形态，不含分时。',
  {
    symbol: z.string().describe('代码或名称：600519 / sh600519 / 茅台'),
    days: z.number().optional().describe('交易日数量，1~250，默认 60'),
  },
  async ({ symbol, days }) => {
    try {
      const sym = await resolveSymbol(symbol);
      const lmt = Math.min(250, Math.max(1, Math.round(days ?? 60)));
      const secid = `${sym.market === 'sh' ? 1 : 0}.${sym.code}`;
      const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}`
        + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58'
        + `&klt=101&fqt=1&end=20500101&lmt=${lmt}`;
      const data = await fetchJson(url);
      const klines = data?.data?.klines ?? [];
      if (!klines.length) throw new Error('没有拿到 K 线（代码可能不对，或该标的没有日线）');
      const bars = klines.map((line) => {
        const [date, open, close, high, low, volume, amount, amplitude] = String(line).split(',');
        return {
          date,
          open: Number(open),
          close: Number(close),
          high: Number(high),
          low: Number(low),
          volume: Number(volume),
          amount: Number(amount),
          amplitudePct: Number(amplitude),
        };
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: true, symbol: `${sym.market}${sym.code}`, name: data?.data?.name ?? sym.name ?? '', count: bars.length, bars }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `查 K 线失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'stock_index',
  '看常见 A 股指数现在的点位和涨跌（上证指数、深证成指、创业板指、科创50、北证50、沪深300）。想聊大盘就用这个。',
  {},
  async () => {
    const list = [
      { key: 'sh000001', label: '上证指数' },
      { key: 'sz399001', label: '深证成指' },
      { key: 'sz399006', label: '创业板指' },
      { key: 'sh000688', label: '科创50' },
      { key: 'bj899050', label: '北证50' },
      { key: 'sh000300', label: '沪深300' },
    ];
    try {
      const text = await fetchText(`https://qt.gtimg.cn/q=${list.map((x) => x.key).join(',')}`, 'gbk');
      const rows = [];
      for (const line of text.split(';')) {
        const t = line.trim();
        if (!t.includes('=')) continue;
        try {
          const q = parseTencentQuote(t);
          const meta = list.find((x) => q.code && t.includes(x.key.slice(2)));
          rows.push({
            name: meta?.label || q.name,
            code: q.code,
            price: q.price,
            change: q.change,
            changePct: q.changePct,
            amountWan: q.amountWan,
            time: q.time,
          });
        } catch {}
      }
      if (!rows.length) throw new Error('没拿到指数行情');
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, indices: rows }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查指数失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
