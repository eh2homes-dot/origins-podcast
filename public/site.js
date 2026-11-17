// Sends the guest and sponsor forms without a page reload.
document.querySelectorAll('form[data-api]').forEach(function (form) {
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var button = form.querySelector('button[type=submit]');
    var status = form.querySelector('[role=status]');
    button.disabled = true;
    status.textContent = 'Sending…';
    try {
      var res = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error);
      form.reset();
      status.textContent = data.message;
    } catch (err) {
      status.textContent = err.message || 'Something went wrong. Please try again.';
    }
    button.disabled = false;
  });
});
// Swap the video poster for the YouTube player on click.
document.querySelectorAll('[data-youtube]').forEach(function (el) {
  el.addEventListener('click', function (event) {
    event.preventDefault();
    var frame = document.createElement('iframe');
    frame.src = 'https://www.youtube-nocookie.com/embed/' + el.dataset.youtube + '?autoplay=1' + (el.dataset.start ? '&start=' + el.dataset.start : '');
    frame.title = el.getAttribute('aria-label') || 'Episode video';
    frame.allow = 'accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    el.parentNode.replaceChild(frame, el);
  });
});
