// Which GitHub app this extension signs into.
//
// A client ID is public by design. The device flow exists precisely for clients
// that cannot keep a secret, and this one holds no secret at all, so committing
// the ID is safe. It is also the point: with the ID in the repo, a new machine
// is "load the extension, press Connect" and nothing else.
//
// Registering the app is a one-time job, written up in README.md. Do it once,
// put the ID here, and never think about tokens again.
const OLPUSH_CLIENT_ID = '';

// Leave blank for a GitHub App: its reach comes from the permissions you gave it
// and the repositories you installed it on, and it ignores this field.
// An OAuth App has no such notion and needs 'repo' here instead.
const OLPUSH_SCOPE = '';
