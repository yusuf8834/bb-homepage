# BB Homepage

BB Homepage adds a "Start in a project" section to BB's new-thread page. Each
project card opens a focused new-thread composer for that project. The plugin
is intentionally separate from provider plugins.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshot-dark.jpeg">
  <img src="docs/screenshot-light.jpeg" alt="The BB new-thread page with the Start in a project launcher: a pinned section above a two-column grid of project cards showing icons, chat counts, relative activity times, and 14-day sparklines">
</picture>

## Features

- Sort projects by recent activity, chat count, name, or a saved manual order.
  In Manual mode, drag a card to reorder it, use Alt+Arrow Up or Alt+Arrow Down
  from the keyboard, and click normally to open it.
- Highlight the project selected in the new-thread composer without moving it
  away from the chosen sort position.
- Control chat counts, projects without chats, Personal, and project artwork
  from plugin settings. All projects are visible by default.
- See each project's chat count, relative last-activity time, and 14-day
  new-chat sparkline. Archived and child chats do not affect these values.
- See at a glance which projects need you. A card shows a **Needs you**,
  **Failed**, or **Running** pill next to its name only when a chat is in that
  state, a **Needs you** filter chip narrows the launcher to those projects,
  and a collapsed group summarizes what is inside it (2 need you · 1 running).
- Read each project's checkout state in the right-hand column of its card:
  `No change`, or the changed file count over `+537 -119` line counts, using the
  same numbers as the chat composer's changes bar. A small branch glyph marks
  a checkout that is off its default branch; hover it for the branch name. The
  sparkline fills the space between the name and this column.
  Hover the line to list the project's worktrees with their own state. Status
  is read once when the page opens and again from the refresh button; a
  plugin setting can also refresh it every 1, 5, or 15 minutes, and another
  turns the checkout line off entirely.
- Open a project’s default checkout in an installed app from the right-click
  **Open in** menu. Uses BB’s desktop helper, including supported remote SSH apps.
- Pin projects from the right-click menu, or drag them into the Pinned section
  in Manual mode. Pinned projects sync across windows.
- Create custom project groups from the launcher. Use a project's right-click
  menu to move it into a group, or drag it between group sections in Manual
  mode. Click a group name to collapse it, or drag its header to reorder it.
  Groups, assignments, and group order sync across windows; collapsed groups
  are remembered in the current browser.
- Rename or hide a project from its right-click menu. Restore all hidden
  projects from plugin settings.
- Respect reduced-motion preferences when drawing sparklines.
- Hide BB's built-in recent-chats section on the compose page so the launcher
  stays focused on starting new chats, and fill the compact phone and
  narrow-window layout with the launcher instead of leaving that space empty.
- Load project artwork from declared BB branding or conventional filenames such
  as `icon.png`, `favicon.ico`, `logo.svg`, and `apple-touch-icon.png`, including
  size and light/dark variants. Other filenames require an explicit
  `bb.branding.icon` path in `package.json`. A named BB icon such as `GridView`
  is drawn as a theme-aware glyph. Personal projects and projects without usable artwork display a
  folder icon.
- Cache icon lookups, coalesce simultaneous requests, and briefly cache missing
  results.
- Retain loaded artwork, groups, and checkout counts between new-thread page
  visits in the same window, refreshing them without resetting the cards.
- Serve only supported images up to 2 MB. The icon endpoint rejects unsafe
  paths, build directories, malformed SVGs, active elements, event handlers,
  foreign namespaces, doctypes, and external references.

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
