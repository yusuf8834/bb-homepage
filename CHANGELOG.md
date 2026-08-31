# Changelog

All notable changes to this project are documented here.

## 0.1.1 - 2026-08-30

- Organize implementation helpers and tests into dedicated directories.
- Align the CI build tool with Plugin SDK 0.4.29.

## 0.1.0 - 2026-08-30

- Add a homepage launcher that starts a new thread in the selected project.
- Add a homepage selector for recent-activity, chat-count, and alphabetical
  project ordering, persisted in the current browser.
- Add pinned projects: pin from the card's hover button or context menu
  (long-press on touch); pins persist server-side and sync across windows.
- Show each project's chat count, relative last-activity time, and a
  14-day new-chat sparkline with a reduced-motion-aware draw animation.
- Add settings for current-project priority, chat counts, unused projects,
  Personal, and project artwork.
- Discover project branding and common icon files with bounded positive and
  negative caching.
- Validate SVG artwork as inert XML and reject unsafe paths, markup, and
  external references.
- Hide the built-in recent-chats section on the compose page in favor of
  the launcher.
