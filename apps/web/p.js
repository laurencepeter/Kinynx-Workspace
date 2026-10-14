// Public, read-only viewer for published pages (/p/:slug). No auth; the API
// enforces publication state and the optional page password.
(function () {
  const slug = (location.pathname.match(/^\/p\/([a-z0-9-]{1,80})$/) || [])[1];
  const $ = (id) => document.getElementById(id);

  async function load(password) {
    if (!slug) return fail("Page not found");
    const res = await fetch(`/api/public/${slug}`, { headers: password ? { "x-page-password": password } : {} });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.password_protected) {
      $("title").textContent = "This page is password protected";
      $("pwForm").hidden = false;
      if (password) $("pw").setCustomValidity("Wrong password"), $("pw").reportValidity();
      return;
    }
    if (!res.ok) return fail("Page not found");
    $("pwForm").hidden = true;
    const seo = data.seo || {};
    document.title = seo.title || data.page.title || "Kinynx";
    if (seo.description) {
      const m = document.createElement("meta");
      m.name = "description"; m.content = seo.description;
      document.head.append(m);
    }
    $("title").textContent = `${data.page.icon ? data.page.icon + " " : ""}${data.page.title}`;
    window.KinynxRender.renderReadOnly(data.blocks, $("body"));
  }

  function fail(msg) { $("title").textContent = msg; }

  $("pwForm").addEventListener("submit", (e) => { e.preventDefault(); $("pw").setCustomValidity(""); load($("pw").value); });
  load().catch(() => fail("Could not load page"));
})();
