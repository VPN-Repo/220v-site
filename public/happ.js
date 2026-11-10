// The «open in Happ» page. The Telegram bot opens /happ.html#<subscription link>; this script turns
// it into happ://add/<link>, the same deep link the dashboard uses. Telegram buttons cannot open
// app links themselves.
//
// The link travels in the URL fragment, so it never reaches the server or its logs, and it is
// removed from the address bar at once. Only this brand's subscription hosts are accepted: the
// page must not add somebody else's subscription to a visitor's app.
(function () {
  var ALLOWED_HOSTS = ["220v.click"];

  var link = "";
  try {
    link = decodeURIComponent(window.location.hash.slice(1));
  } catch (e) {
    link = "";
  }
  try {
    window.history.replaceState(null, "", window.location.pathname);
  } catch (e) {
    // The address bar keeps the fragment; nothing else changes.
  }

  function allowed(value) {
    try {
      var url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) return false;
      for (var i = 0; i < ALLOWED_HOSTS.length; i++) {
        var host = ALLOWED_HOSTS[i];
        if (url.hostname === host || url.hostname.slice(-host.length - 1) === "." + host) return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  var byId = function (id) {
    return document.getElementById(id);
  };

  if (!allowed(link)) {
    byId("title").hidden = true;
    byId("text").hidden = true;
    byId("bad").hidden = false;
    return;
  }

  var deepLink = "happ://add/" + encodeURIComponent(link);
  var button = byId("open");
  button.href = deepLink;
  button.hidden = false;
  byId("hint").hidden = false;
  window.location.href = deepLink;
})();
