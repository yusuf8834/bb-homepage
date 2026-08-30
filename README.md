# BB Homepage

BB Homepage adds a "Start in a project" section to BB's new-thread page. Each
project card opens a focused new-thread composer for that project. The plugin
is intentionally separate from provider plugins.

Recent activity is the default ordering. A selector above the project cards
also offers most chats and alphabetical ordering, and remembers the choice in
the current browser. Plugin settings control current-project priority, chat
counts, projects without chats, Personal, and project artwork. All projects
remain visible by default. Archived chats and child chats do not affect usage
data.

For ordinary projects, the plugin looks for a declared BB branding icon or a
likely icon, favicon, or logo in the project files. Personal projects and
projects without a usable image display a folder icon. Project icons are cached
in a bounded least-recently-used cache, including short-lived negative results,
and simultaneous requests are coalesced.

The icon endpoint only serves supported image types, rejects unsafe paths and
build directories, and limits images to 2 MB. SVG files are parsed as XML and
rejected if they contain active elements, event handlers, foreign namespaces,
external references, doctypes, or malformed markup.

## Requirements

- BB 0.40 or later
- Plugin SDK 0.4.29 or later

## Development

```sh
npm install --include=dev
npm test
npm run typecheck
npm exec -- bb plugin types --check .
npm run build
```

Install the working directory into BB with:

```sh
bb plugin install path:$PWD
```

After changing an installed local copy, run `bb plugin reload homepage`.
