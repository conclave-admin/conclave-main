export function pushSupport(win=window){return Boolean(win.isSecureContext&&win.Notification&&win.PushManager&&win.navigator.serviceWorker);}
export function applicationKey(value){return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
