# BB Homepage

BB Homepage adds a "Start in a project" section to BB's new-thread page.
It is intentionally separate from provider plugins.

Projects are ordered by active top-level chat count, then by recent activity,
then by name. Selecting a project opens its new-thread composer. Archived chats
and child chats do not affect the ranking.

For ordinary projects, the plugin looks for a declared BB branding icon or a
likely icon, favicon, or logo in the project files. Personal projects and
projects without a usable image display a folder icon. The icon endpoint only
serves supported image types, rejects unsafe paths and build directories, and
limits images to 2 MB.

## Development

```sh
npm install --include=dev
npm test
npm run typecheck
npm run build
```

Install the working directory into BB with:

```sh
bb plugin install .
```
