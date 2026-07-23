'use strict';

// Thin wrappers over the JSON endpoints exposed by the Node backend.
export const api = {
  async root() { return (await fetch('/api/root')).json(); },
  async canvas(id) { return (await fetch('/api/canvas/' + id)).json(); },
  async patchCanvas(id, body) { return (await fetch('/api/canvas/' + id, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })).json(); },
  async create(body) { return (await fetch('/api/item', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })).json(); },
  async patch(id, body) { return (await fetch('/api/item/' + id, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })).json(); },
  async patchMany(updates) { return (await fetch('/api/items', { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({updates}) })).json(); },
  async remove(id) { return (await fetch('/api/item/' + id, { method:'DELETE' })).json(); },
  async upload(file) { const fd = new FormData(); fd.append('file', file); return (await fetch('/api/upload', { method:'POST', body:fd })).json(); }
};
