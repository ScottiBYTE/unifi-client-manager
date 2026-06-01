const express = require('express');
const path = require('path');
const fs = require('fs');
const { Agent } = require('undici');

const config = {
  unifiBaseUrl: process.env.UNIFI_BASE_URL,
  username: process.env.UNIFI_USERNAME,
  password: process.env.UNIFI_PASSWORD,
  site: process.env.UNIFI_SITE || 'default',
  port: Number(process.env.PORT || 3000),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15000),
  verifySsl: process.env.VERIFY_SSL === 'true',
  unifiUiBaseUrl: process.env.UNIFI_UI_BASE_URL || process.env.UNIFI_BASE_URL
};

if (!config.unifiBaseUrl || !config.username || !config.password) {
  console.error('Missing UNIFI_BASE_URL, UNIFI_USERNAME, or UNIFI_PASSWORD');
  process.exit(1);
}

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const fetchDispatcher = new Agent({
  connect: {
    rejectUnauthorized: Boolean(config.verifySsl)
  }
});

let latestClients = [];
let lastRefresh = null;
let lastError = null;
let refreshInProgress = false;


function getAppInfo() {
  let pkg = {};

  try {
    const packageJsonPath = path.join(__dirname, 'package.json');
    const packageJsonText = fs.readFileSync(packageJsonPath, 'utf8');
    pkg = JSON.parse(packageJsonText);
  } catch (err) {
    console.error('Unable to read package.json:', err.message || String(err));
  }

  const name = pkg.name || 'unifi-client-manager';
  const version = pkg.version || '0.0.0';

  return {
    name,
    version,
    githubUrl: `https://github.com/ScottiBYTE/unifi-client-manager/releases/tag/v${version}`,
    donateUrl: 'https://www.paypal.com/paypalme/ScottiBYTE'
  };
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeMac(mac) {
  return String(mac || '').trim().toUpperCase();
}

function chooseName(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }

  return '';
}

function parseSetCookie(headers) {
  if (typeof headers.getSetCookie === 'function') {
    const cookies = headers.getSetCookie();

    if (Array.isArray(cookies) && cookies.length > 0) {
      return cookies.map(cookie => cookie.split(';')[0]).join('; ');
    }
  }

  const rawCookie = headers.get('set-cookie');

  if (!rawCookie) {
    return '';
  }

  return rawCookie
    .split(/,(?=[^;]+=[^;]+)/)
    .map(cookie => cookie.split(';')[0].trim())
    .join('; ');
}

function ipToNumber(ip) {
  if (!ip) {
    return 0;
  }

  const parts = ip.split('.').map(Number);

  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) {
    return 0;
  }

  return ((parts[0] << 24) >>> 0) +
    (parts[1] << 16) +
    (parts[2] << 8) +
    parts[3];
}

function formatLastSeenFromTs(ts) {
  const n = Number(ts || 0);

  if (!n) {
    return 'Unknown';
  }

  const ageSeconds = Math.max(
    0,
    Math.floor(Date.now() / 1000) - n
  );

  if (ageSeconds < 60) {
    return 'Now';
  }

  if (ageSeconds < 3600) {
    return `${Math.floor(ageSeconds / 60)}m ago`;
  }

  if (ageSeconds < 86400) {
    return `${Math.floor(ageSeconds / 3600)}h ago`;
  }

  return `${Math.floor(ageSeconds / 86400)}d ago`;
}

function getClientId(userClient, activeClient) {
  return chooseName(
    userClient?._id,
    userClient?.id,
    userClient?.user_id,
    activeClient?._id,
    activeClient?.id,
    activeClient?.user_id
  );
}

function buildUnifiClientsPageUrl() {
  return `${trimTrailingSlash(config.unifiUiBaseUrl)}/network/${encodeURIComponent(config.site)}/clients/main`;
}

async function unifiLogin() {
  const loginUrl = `${trimTrailingSlash(config.unifiBaseUrl)}/api/auth/login`;

  const response = await fetch(loginUrl, {
    method: 'POST',
    dispatcher: fetchDispatcher,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      username: config.username,
      password: config.password
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`UniFi login failed: ${response.status} ${text}`);
  }

  const cookie = parseSetCookie(response.headers);

  if (!cookie) {
    throw new Error('UniFi login succeeded but no session cookie was returned');
  }

  return cookie;
}

async function fetchJson(url, cookie) {
  const response = await fetch(url, {
    method: 'GET',
    dispatcher: fetchDispatcher,
    headers: {
      Cookie: cookie,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`UniFi fetch failed: ${response.status} ${text}`);
  }

  return response.json();
}

function buildClientFromMerged(userClient, activeClient) {
  const user = userClient || {};
  const active = activeClient || {};

  const mac = normalizeMac(chooseName(active.mac, user.mac));
  const ip = chooseName(active.ip, user.ip, user.fixed_ip);
  const clientName = chooseName(user.name, active.name);
  const dnsName = chooseName(
    active.hostname,
    user.hostname,
    active.dns_name,
    user.dns_name
  );

  const network = chooseName(
    user.network,
    user.network_name,
    active.network,
    active.network_name,
    user.essid,
    active.essid
  );

  const reserved =
    Boolean(user.use_fixedip) ||
    Boolean(user.fixed_ip) ||
    Boolean(user.is_fixed_ip) ||
    Boolean(user.is_reserved) ||
    Boolean(user.reserved) ||
    Boolean(active.use_fixedip) ||
    Boolean(active.fixed_ip) ||
    Boolean(active.is_fixed_ip) ||
    Boolean(active.is_reserved) ||
    Boolean(active.reserved);

  let connectionType = 'unknown';

  if (active.is_wired === true || user.is_wired === true) {
    connectionType = 'wired';
  } else if (active.is_wired === false || user.is_wired === false) {
    connectionType = 'wifi';
  } else if (active.sw_mac || user.sw_mac) {
    connectionType = 'wired';
  } else if (
    active.ap_mac ||
    user.ap_mac ||
    active.ap_name ||
    user.ap_name
  ) {
    connectionType = 'wifi';
  }

  let uplink = '';

  if (connectionType === 'wired') {
    const swName = chooseName(
      active.sw_name,
      user.sw_name,
      active.switch_name,
      user.switch_name
    );

    const swPort = chooseName(
      active.sw_port,
      user.sw_port,
      active.port,
      user.port
    );

    if (swName && swPort) {
      uplink = `${swName} / Port ${swPort}`;
    } else if (swPort) {
      uplink = `Port ${swPort}`;
    } else if (swName) {
      uplink = swName;
    }
  } else if (connectionType === 'wifi') {
    uplink = chooseName(
      active.ap_name,
      user.ap_name,
      active.radio_name,
      user.radio_name,
      active.radio,
      user.radio
    );
  }

  const online = Boolean(activeClient);
  const lastSeenTs = Number(chooseName(active.last_seen, user.last_seen, 0));
  const clientsPageUrl = buildUnifiClientsPageUrl();

  return {
    client_name: clientName,
    dns_name: dnsName,
    ip,
    reserved,
    mac,
    network,
    connection_type: connectionType,
    uplink,
    last_seen: online ? 'Now' : formatLastSeenFromTs(lastSeenTs),
    last_seen_ts: lastSeenTs,
    status: online ? 'online' : 'offline',

    unifi_id: getClientId(user, active),

    // UniFi does not expose a reliable browser URL that highlights a specific client.
    // This opens the Clients page; the frontend should copy the MAC so it can be pasted into UniFi search.
    unifi_url: clientsPageUrl,
    unifi_search_url: clientsPageUrl
  };
}

async function fetchClientsFromUnifi() {
  const cookie = await unifiLogin();
  const base = trimTrailingSlash(config.unifiBaseUrl);

  const userUrl = `${base}/proxy/network/api/s/${config.site}/rest/user`;
  const staUrl = `${base}/proxy/network/api/s/${config.site}/stat/sta`;

  const [userJson, staJson] = await Promise.all([
    fetchJson(userUrl, cookie),
    fetchJson(staUrl, cookie)
  ]);

  const userRows = Array.isArray(userJson.data) ? userJson.data : [];
  const activeRows = Array.isArray(staJson.data) ? staJson.data : [];

  const userMap = new Map();
  const activeMap = new Map();

  for (const row of userRows) {
    const mac = normalizeMac(row.mac);

    if (mac) {
      userMap.set(mac, row);
    }
  }

  for (const row of activeRows) {
    const mac = normalizeMac(row.mac);

    if (mac) {
      activeMap.set(mac, row);
    }
  }

  const allMacs = new Set([
    ...userMap.keys(),
    ...activeMap.keys()
  ]);

  const merged = [];

  for (const mac of allMacs) {
    merged.push(
      buildClientFromMerged(
        userMap.get(mac),
        activeMap.get(mac)
      )
    );
  }

  return merged.sort((a, b) => {
    const an = a.client_name ? a.client_name.toLowerCase() : '~~~~';
    const bn = b.client_name ? b.client_name.toLowerCase() : '~~~~';

    if (an < bn) {
      return -1;
    }

    if (an > bn) {
      return 1;
    }

    return ipToNumber(a.ip) - ipToNumber(b.ip);
  });
}

async function refreshClients() {
  if (refreshInProgress) {
    return;
  }

  refreshInProgress = true;

  try {
    const clients = await fetchClientsFromUnifi();

    latestClients = clients;
    lastRefresh = new Date().toISOString();
    lastError = null;

    console.log(`Refreshed ${clients.length} clients at ${lastRefresh}`);
  } catch (err) {
    lastError = err.stack || err.message || String(err);

    console.error('Refresh failed FULL ERROR:\n', lastError);
  } finally {
    refreshInProgress = false;
  }
}

function csvEscape(value) {
  const s = String(value ?? '');

  if (
    s.includes(',') ||
    s.includes('"') ||
    s.includes('\n')
  ) {
    return `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}

async function unifiApiRequest(method, url, cookie, body = null) {
  const options = {
    method,
    dispatcher: fetchDispatcher,
    headers: {
      Cookie: cookie,
      Accept: 'application/json'
    }
  };

  if (body !== null) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`UniFi API request failed: ${response.status} ${text}`);
  }

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text
    };
  }
}



app.get('/api/app-info', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json(getAppInfo());
});


app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    refreshedAt: lastRefresh,
    error: lastError,
    site: config.site,
    uiBaseUrl: trimTrailingSlash(config.unifiUiBaseUrl),
    clientsPageUrl: buildUnifiClientsPageUrl()
  });
});

app.get('/api/clients', (req, res) => {
  res.json(latestClients);
});

app.get('/api/client/:mac/link', (req, res) => {
  const mac = normalizeMac(req.params.mac);

  const client = latestClients.find(c =>
    normalizeMac(c.mac) === mac
  );

  if (!client) {
    return res.status(404).json({
      error: 'Client not found'
    });
  }

  res.json({
    ok: true,
    mac: client.mac,
    ip: client.ip,
    client_name: client.client_name,
    unifi_id: client.unifi_id,
    url: client.unifi_url,
    search_url: client.unifi_search_url,
    has_exact_link: false,
    note: 'UniFi opens the Clients page only. Copy the MAC and paste it into UniFi search.'
  });
});

app.get('/api/debug/raw-clients', (req, res) => {
  const limit = Math.max(
    1,
    Math.min(20, Number(req.query.limit || 5))
  );

  res.json({
    count: latestClients.length,
    sample: latestClients.slice(0, limit)
  });
});

app.get('/api/export/reservations.csv', (req, res) => {
  const headers = [
    'client_name',
    'dns_name',
    'mac',
    'ip',
    'reserved',
    'network',
    'status',
    'unifi_id',
    'unifi_url'
  ];

  const lines = [
    headers.join(',')
  ];

  for (const row of latestClients) {
    lines.push([
      csvEscape(row.client_name),
      csvEscape(row.dns_name),
      csvEscape(row.mac),
      csvEscape(row.ip),
      csvEscape(String(row.reserved)),
      csvEscape(row.network),
      csvEscape(row.status),
      csvEscape(row.unifi_id),
      csvEscape(row.unifi_url)
    ].join(','));
  }

  res.setHeader(
    'Content-Type',
    'text/csv; charset=utf-8'
  );

  res.setHeader(
    'Content-Disposition',
    'attachment; filename="unifi-reservations.csv"'
  );

  res.send(lines.join('\n'));
});

app.post('/api/client/:mac/toggle-reservation', async (req, res) => {
  try {
    const mac = normalizeMac(req.params.mac);

    const client = latestClients.find(c =>
      normalizeMac(c.mac) === mac
    );

    if (!client) {
      return res.status(404).json({
        error: 'Client not found'
      });
    }

    const cookie = await unifiLogin();
    const base = trimTrailingSlash(config.unifiBaseUrl);
    const url = `${base}/proxy/network/api/s/${config.site}/cmd/stamgr`;

    let body;

    if (client.reserved) {
      body = {
        cmd: 'unset-fixed-ip',
        mac
      };
    } else {
      if (!client.ip) {
        return res.status(400).json({
          error: 'Client has no IP to reserve'
        });
      }

      body = {
        cmd: 'set-fixed-ip',
        mac,
        ip: client.ip
      };
    }

    await unifiApiRequest('POST', url, cookie, body);

    console.log(`Reservation toggled for ${mac}`);

    await refreshClients();

    res.json({
      ok: true,
      mac
    });
  } catch (err) {
    console.error(
      'Toggle reservation failed:\n',
      err.stack || err.message || String(err)
    );

    res.status(500).json({
      error: err.message || String(err)
    });
  }
});

app.delete('/api/client/:mac', async (req, res) => {
  try {
    const mac = normalizeMac(req.params.mac);
    const cookie = await unifiLogin();
    const base = trimTrailingSlash(config.unifiBaseUrl);
    const url = `${base}/proxy/network/api/s/${config.site}/cmd/stamgr`;

    await unifiApiRequest('POST', url, cookie, {
      cmd: 'forget-sta',
      mac
    });

    console.log(`Forgot client ${mac}`);

    await refreshClients();

    res.json({
      ok: true,
      mac
    });
  } catch (err) {
    console.error(
      'Delete client failed:\n',
      err.stack || err.message || String(err)
    );

    res.status(500).json({
      error: err.message || String(err)
    });
  }
});

app.get('/', (req, res) => {
  try {
    const appInfo = getAppInfo();
    const indexPath = path.join(__dirname, 'index.html');

    let html = fs.readFileSync(indexPath, 'utf8');

    html = html
      .replace(/GitHub v[0-9]+\.[0-9]+\.[0-9]+|GitHub v--/g, `GitHub v${appInfo.version}`)
      .replace(
        /https:\/\/github\.com\/ScottiBYTE\/unifi-client-manager\/releases\/tag\/v[0-9]+\.[0-9]+\.[0-9]+/g,
        appInfo.githubUrl
      )
      .replace(
        /https:\/\/www\.paypal\.com\/paypalme\/ScottiBYTE/g,
        appInfo.donateUrl
      );

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html').send(html);
  } catch (err) {
    console.error('Failed to serve index.html:', err.stack || err.message || String(err));
    res.status(500).send('Failed to load UniFi Client Reservation Manager');
  }
});

refreshClients();

setInterval(refreshClients, config.pollIntervalMs);

app.listen(config.port, () => {
  console.log(
    `UniFi Client Manager listening on http://0.0.0.0:${config.port}`
  );
});

