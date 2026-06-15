/**
 * The inlined dev-playground UI: a single self-contained HTML document (inline
 * HTML + vanilla JS + CSS) served as a string. No React, no bundler, zero new
 * runtime deps — the constraint keeps the CLI small.
 *
 * It fetches /api/tools and renders one card per servable tool (a form built
 * from the inferred inputSchema), runs a tool via POST /api/call, and shows the
 * result, the generated inputSchema, and the raw JSON-RPC (the inspector view).
 * Fail-loud excluded tools are listed greyed out with their reasons. It
 * subscribes to /api/events and, on a `reload`, re-fetches and re-renders while
 * preserving entered values for fields that still exist.
 *
 * The browser-side `schemaToField` below is a faithful transcription of the pure
 * `schemaPropertyToField` in src/ui-schema.ts — that TS copy is the canonical,
 * unit-tested one. Keep the two in sync.
 *
 * Implementation note: the UI script uses string concatenation and DOM APIs (no
 * template literals) so this whole document can live inside a TS template
 * literal without escaping backticks or `${`.
 */
export function renderDevUi(): string {
  return PAGE;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mcp-gen dev playground</title>
<style>
  :root {
    --bg: #0f1117; --panel: #181b24; --panel-2: #1f2330; --border: #2b3040;
    --text: #e6e8ee; --muted: #9aa3b2; --accent: #6ea8fe; --accent-2: #3b82f6;
    --ok: #3fb950; --err: #f85149; --code-bg: #0b0d13;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  header {
    padding: 14px 20px; border-bottom: 1px solid var(--border);
    display: flex; align-items: baseline; gap: 12px; background: var(--panel);
    position: sticky; top: 0; z-index: 2;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .file { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  header .status { margin-left: auto; font-size: 12px; color: var(--muted); }
  header .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); margin-right: 6px; vertical-align: middle; }
  main { max-width: 920px; margin: 0 auto; padding: 20px; }
  .banner { background: #3a1d1d; border: 1px solid var(--err); color: #ffd7d4; padding: 12px 14px; border-radius: 8px; margin-bottom: 16px; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 2px; font-size: 15px; font-family: ui-monospace, monospace; }
  .card .desc { color: var(--muted); margin: 0 0 12px; font-size: 13px; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
  .field label .req { color: var(--err); margin-left: 3px; }
  .field label .ty { color: var(--accent); margin-left: 6px; font-family: ui-monospace, monospace; }
  .field input[type=text], .field input[type=number], .field select, .field textarea {
    width: 100%; background: var(--panel-2); border: 1px solid var(--border); color: var(--text);
    border-radius: 6px; padding: 7px 9px; font: inherit;
  }
  .field textarea { font-family: ui-monospace, monospace; font-size: 12px; min-height: 56px; resize: vertical; }
  .field .hint { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .row { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
  button.run {
    background: var(--accent-2); color: white; border: 0; border-radius: 6px;
    padding: 8px 16px; font: inherit; font-weight: 600; cursor: pointer;
  }
  button.run:hover { background: var(--accent); }
  .out { margin-top: 12px; display: none; }
  .out.show { display: block; }
  .out .result { padding: 10px 12px; border-radius: 6px; background: var(--code-bg); border: 1px solid var(--border); white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; }
  .out .result.ok { border-left: 3px solid var(--ok); }
  .out .result.err { border-left: 3px solid var(--err); color: #ffb4ae; }
  details { margin-top: 10px; }
  summary { cursor: pointer; color: var(--muted); font-size: 12px; user-select: none; }
  pre.code { background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; overflow: auto; font-family: ui-monospace, monospace; font-size: 12px; margin: 6px 0 0; }
  .excluded { opacity: 0.6; }
  .excluded .card { border-style: dashed; }
  .excluded h2 .tag { font-size: 11px; color: var(--err); border: 1px solid var(--err); border-radius: 4px; padding: 1px 6px; margin-left: 8px; vertical-align: middle; font-family: inherit; }
  .section-title { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; margin: 24px 0 10px; }
  .empty { color: var(--muted); font-style: italic; }
  a { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>mcp-gen <span style="color:var(--accent)">dev</span></h1>
  <span class="file" id="file"></span>
  <span class="status"><span class="dot" id="dot"></span><span id="status">connecting…</span></span>
</header>
<main>
  <div id="banner"></div>
  <div id="app"></div>
</main>
<script>
(function () {
  "use strict";

  var state = { ok: true, file: "", tools: [], errors: [], warnings: [], fileError: null };
  var reqId = 0;

  // Faithful transcription of schemaPropertyToField (src/ui-schema.ts).
  function schemaToField(name, schema, required) {
    var f = { name: name, kind: "json", required: required };
    if (!schema || typeof schema !== "object") return f;
    if (typeof schema.description === "string" && schema.description) f.description = schema.description;
    if (Object.prototype.hasOwnProperty.call(schema, "const")) {
      var c = schema["const"];
      f.kind = "enum"; f.enumValues = [c]; f.numericEnum = (typeof c === "number");
      return f;
    }
    if (Array.isArray(schema.enum)) {
      var vals = schema.enum;
      var allNum = vals.length > 0 && vals.every(function (v) { return typeof v === "number"; });
      f.kind = "enum"; f.enumValues = vals;
      f.numericEnum = (schema.type === "number" || schema.type === "integer" || allNum);
      return f;
    }
    switch (schema.type) {
      case "boolean": f.kind = "boolean"; return f;
      case "integer": f.kind = "integer"; return f;
      case "number": f.kind = "number"; return f;
      case "string": f.kind = "string"; return f;
      default: return f;
    }
  }

  function fieldsOf(tool) {
    var schema = tool.inputSchema || {};
    var props = schema.properties || {};
    var required = Array.isArray(schema.required) ? schema.required : [];
    return Object.keys(props).map(function (name) {
      return schemaToField(name, props[name], required.indexOf(name) !== -1);
    });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  // ---- value preservation across re-render -------------------------------
  // Keyed by tool::field AND the field's kind, so a reload that changes a
  // parameter's type does not mis-restore (e.g. a captured string into a new
  // checkbox); a kind change simply drops the stale value.
  function captureValues() {
    var map = {};
    document.querySelectorAll("[data-field]").forEach(function (e) {
      var key = e.getAttribute("data-tool") + "::" + e.getAttribute("data-field");
      map[key] = { kind: e.getAttribute("data-kind"), value: (e.type === "checkbox") ? e.checked : e.value };
    });
    return map;
  }
  function restoreValues(map) {
    document.querySelectorAll("[data-field]").forEach(function (e) {
      var key = e.getAttribute("data-tool") + "::" + e.getAttribute("data-field");
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        var saved = map[key];
        if (saved.kind !== e.getAttribute("data-kind")) return; // kind changed — drop it
        if (e.type === "checkbox") e.checked = saved.value;
        else e.value = saved.value;
      }
    });
  }

  // ---- form control per field --------------------------------------------
  function controlFor(tool, field) {
    var common = { "data-field": field.name, "data-tool": tool.name, "data-kind": field.kind };
    if (field.kind === "boolean") {
      var cb = el("input", common); cb.type = "checkbox"; return cb;
    }
    if (field.kind === "enum") {
      var sel = el("select", common);
      if (!field.required) sel.appendChild(el("option", { value: "", text: "— (omit) —" }));
      (field.enumValues || []).forEach(function (v) {
        sel.appendChild(el("option", { value: String(v), text: String(v) }));
      });
      return sel;
    }
    if (field.kind === "json") {
      var ta = el("textarea", common);
      ta.placeholder = "JSON, e.g. [1,2,3] or {\\"k\\":\\"v\\"}";
      return ta;
    }
    var inp = el("input", common);
    inp.type = (field.kind === "number" || field.kind === "integer") ? "number" : "text";
    if (field.kind === "integer") inp.step = "1";
    return inp;
  }

  function typeLabel(field) {
    if (field.kind === "enum") return "enum(" + (field.enumValues || []).join(" | ") + ")";
    return field.kind;
  }

  function fieldRow(tool, field) {
    var label = el("label", {}, [ document.createTextNode(field.name) ]);
    if (field.required) label.appendChild(el("span", { "class": "req", text: "*" }));
    label.appendChild(el("span", { "class": "ty", text: typeLabel(field) }));
    var control = controlFor(tool, field);
    var kids = [label, control];
    if (field.description) kids.push(el("div", { "class": "hint", text: field.description }));
    return el("div", { "class": "field" }, kids);
  }

  // ---- coercion before POST ----------------------------------------------
  function coerceArgs(tool) {
    var args = {};
    var fields = fieldsOf(tool);
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      var sel = "[data-tool='" + tool.name + "'][data-field='" + field.name + "']";
      var e = document.querySelector(sel);
      if (!e) continue;
      if (field.kind === "boolean") { args[field.name] = e.checked; continue; }
      var raw = e.value;
      var isEmpty = (raw === "" || raw === null || typeof raw === "undefined");
      if (isEmpty) {
        if (field.required) { return { error: "field '" + field.name + "' is required" }; }
        continue; // omit optional empty so JS defaults can fire
      }
      if (field.kind === "number" || field.kind === "integer") {
        var n = Number(raw);
        if (isNaN(n)) return { error: "field '" + field.name + "' must be a number" };
        args[field.name] = n;
      } else if (field.kind === "enum") {
        args[field.name] = field.numericEnum ? Number(raw) : raw;
      } else if (field.kind === "json") {
        try { args[field.name] = JSON.parse(raw); }
        catch (err) { return { error: "field '" + field.name + "' is not valid JSON: " + err.message }; }
      } else {
        args[field.name] = raw;
      }
    }
    return { args: args };
  }

  // ---- run + render output ------------------------------------------------
  function jsonRpcRequest(tool, args) {
    reqId += 1;
    return { jsonrpc: "2.0", id: reqId, method: "tools/call", params: { name: tool, arguments: args } };
  }

  function showOutput(card, parts) {
    var out = card.querySelector(".out");
    out.innerHTML = "";
    out.className = "out show";
    parts.forEach(function (p) { out.appendChild(p); });
  }

  function pre(obj) { return el("pre", { "class": "code", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }); }

  function runTool(tool, card) {
    var coerced = coerceArgs(tool);
    if (coerced.error) {
      showOutput(card, [ el("div", { "class": "result err", text: "client error: " + coerced.error }) ]);
      return;
    }
    var rpc = jsonRpcRequest(tool.name, coerced.args);
    fetch("/api/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: tool.name, args: coerced.args })
    }).then(function (r) { return r.json(); }).then(function (body) {
      var resultBox;
      if (body.ok) {
        resultBox = el("div", { "class": "result ok", text: body.result });
      } else {
        resultBox = el("div", { "class": "result err", text: "isError: " + (body.message || "(no message)") });
      }
      var schemaDetails = el("details", {}, [ el("summary", { text: "generated inputSchema" }), pre(tool.inputSchema) ]);
      var reqDetails = el("details", {}, [ el("summary", { text: "raw JSON-RPC request (equivalent MCP tools/call)" }), pre(rpc) ]);
      var resDetails = el("details", {}, [ el("summary", { text: "raw response" }), pre(body) ]);
      showOutput(card, [ resultBox, schemaDetails, reqDetails, resDetails ]);
    }).catch(function (err) {
      showOutput(card, [ el("div", { "class": "result err", text: "request failed: " + err.message }) ]);
    });
  }

  function toolCard(tool) {
    var card = el("div", { "class": "card" });
    card.appendChild(el("h2", { text: tool.name }));
    card.appendChild(el("p", { "class": "desc", text: tool.description || "(no description)" }));
    var fields = fieldsOf(tool);
    if (fields.length === 0) {
      card.appendChild(el("div", { "class": "hint", text: "no parameters" }));
    } else {
      fields.forEach(function (f) { card.appendChild(fieldRow(tool, f)); });
    }
    var btn = el("button", { "class": "run", text: "Run" });
    btn.addEventListener("click", function () { runTool(tool, card); });
    card.appendChild(el("div", { "class": "row" }, [ btn ]));
    card.appendChild(el("div", { "class": "out" }));
    return card;
  }

  function excludedCard(err) {
    var card = el("div", { "class": "card" });
    var h = el("h2", {}, [ document.createTextNode(err.function || "(anonymous)") ]);
    h.appendChild(el("span", { "class": "tag", text: "excluded" }));
    card.appendChild(h);
    card.appendChild(el("p", { "class": "desc", text: err.message || "" }));
    (err.failures || []).forEach(function (f) {
      card.appendChild(el("div", { "class": "hint", text: f.parameterPath + ": " + f.reason }));
      if (f.hint) card.appendChild(el("div", { "class": "hint", text: "fix: " + f.hint }));
    });
    return card;
  }

  // ---- render -------------------------------------------------------------
  function render() {
    document.getElementById("file").textContent = state.file || "";
    var banner = document.getElementById("banner");
    banner.innerHTML = "";
    if (state.fileError) {
      banner.appendChild(el("div", { "class": "banner", text: "file error (server still up):\\n" + state.fileError }));
    } else if (state.warnings && state.warnings.length) {
      banner.appendChild(el("div", { "class": "banner", text: "warnings:\\n" + state.warnings.join("\\n") }));
    }

    var prev = captureValues();
    var app = document.getElementById("app");
    app.innerHTML = "";

    if (state.tools.length === 0 && !state.fileError) {
      app.appendChild(el("p", { "class": "empty", text: "No servable tools." }));
    }
    state.tools.forEach(function (t) { app.appendChild(toolCard(t)); });

    if (state.errors && state.errors.length) {
      app.appendChild(el("div", { "class": "section-title", text: "Fail-loud excluded" }));
      var wrap = el("div", { "class": "excluded" });
      state.errors.forEach(function (e) { wrap.appendChild(excludedCard(e)); });
      app.appendChild(wrap);
    }

    restoreValues(prev);
  }

  function setStatus(text, ok) {
    document.getElementById("status").textContent = text;
    document.getElementById("dot").style.background = ok ? "var(--ok)" : "var(--err)";
  }

  function load() {
    return fetch("/api/tools").then(function (r) { return r.json(); }).then(function (data) {
      state = {
        ok: data.ok !== false,
        file: data.file || "",
        tools: data.tools || [],
        errors: data.errors || [],
        warnings: data.warnings || [],
        fileError: data.fileError || null
      };
      render();
      setStatus(state.fileError ? "file error" : "ready", !state.fileError);
    }).catch(function (err) {
      setStatus("api error", false);
    });
  }

  // ---- live reload over SSE ----------------------------------------------
  function connectEvents() {
    var ev = new EventSource("/api/events");
    ev.addEventListener("open", function () { setStatus("ready", true); });
    ev.addEventListener("reload", function () { load(); });
    ev.addEventListener("error", function () { setStatus("reconnecting…", false); });
  }

  load();
  connectEvents();
})();
</script>
</body>
</html>`;
