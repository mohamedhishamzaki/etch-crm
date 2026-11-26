self.addEventListener('push',event=>{
  let message={};
  try { message=event.data?.json() || {}; } catch {}
  event.waitUntil(self.registration.showNotification(message.title || 'ETCH CRM',{
    body:message.body || 'Follow-up reminder',icon:'/etch-icon.png',tag:message.tag || 'etch-reminder',
    data:{deal:typeof message.dealId==='string'?message.dealId.slice(0,200):''}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const deal=event.notification.data?.deal || '';
  const url='/?view=followups'+(deal?'&deal='+encodeURIComponent(deal):'');
  event.waitUntil((async()=>{
    const tabs=await clients.matchAll({type:'window',includeUncontrolled:true});
    const open=tabs.find(tab=>new URL(tab.url).origin===self.location.origin && ['/', '/index.html'].includes(new URL(tab.url).pathname));
    if (!open || !deal) return clients.openWindow(url);
    await open.focus();
    open.postMessage({type:'etch-reminder',deal});
  })());
});

