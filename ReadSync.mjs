// read-sync.ts
function enqueueRefresh(queue, req) {
  const q = queue.slice();
  const barrier = (r) => r.markRead || r.unreadChat || r.act;
  if (!barrier(req)) {
    for (let i = q.length - 1;i >= 0; i--) {
      if (barrier(q[i]))
        break;
      if (q[i].readChat === req.readChat) {
        q[i] = Object.assign({}, req, { deep: q[i].deep || req.deep, seen: req.seen > q[i].seen ? req.seen : q[i].seen });
        return q;
      }
    }
  }
  q.push(req);
  return q;
}
export {
  enqueueRefresh
};
