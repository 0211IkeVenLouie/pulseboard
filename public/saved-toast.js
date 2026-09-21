/* After a save we return the person to where they were, which means the change
   is somewhere on the page rather than in front of them. A brief confirmation
   is what tells them the save actually happened. */

const params = new URLSearchParams(window.location.search);
const saved = params.get('saved');

if (saved) {
  const holder = document.getElementById('toasts') ?? Object.assign(document.createElement('div'), { className: 'toasts', id: 'toasts' });
  if (!holder.isConnected) document.body.append(holder);

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = `${saved} saved`;
  holder.append(toast);
  setTimeout(() => toast.remove(), 2600);

  // Briefly mark the row or card that changed, so the eye knows where to look.
  const target = document.querySelector(`[data-issue-key="${CSS.escape(saved)}"]`);
  if (target) {
    target.classList.add('just-saved');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => target.classList.remove('just-saved'), 2000);
  }

  // Drop the parameter so a refresh does not repeat the message.
  params.delete('saved');
  const query = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
}
