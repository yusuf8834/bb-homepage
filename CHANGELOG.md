# Changelog

All notable changes to this project are documented here.

## Unreleased

- Keep loaded icons, project groups, and checkout counts visible when returning
  to the new-chat page while fresh data loads. Measure sparklines before paint
  and load card images eagerly to avoid navigation flicker.
- Show a Needs you, Failed, or Running pill on project cards whose chats are
  blocked on the user, ended in an unread error, or are still working. Add a
  Needs you filter chip and summarize collapsed groups (2 need you · 1 running).
- Show each project's uncommitted changes in a two-line right-hand card
  column, with a branch glyph when the checkout is off its default branch, with a hover list of the project's worktrees when it
  has any. The chat count stays under the name and the sparkline stretches to
  fill whatever room the card has left, so the name and status keep theirs. Status loads once per page,
  refreshes from a toolbar button, and can optionally refresh on a timer from
  plugin settings. Reads are cached briefly and capped in parallel.
- Remove the decorative plus icon from project cards; clicking the card
  already starts a chat.

## 0.2.3 - 2026-09-12

- Stop fuzzy image searches from selecting screenshots and unrelated assets as
  project icons. Require conventional icon or logo filenames, while preserving
  explicit BB branding and the folder fallback.

## 0.2.2 - 2026-09-05

- Add synced custom project groups with create, rename, and delete controls.
- Move projects into groups from the right-click menu or by dragging between
  sections in Manual mode. Pinned projects keep their group assignment and
  return to it when unpinned.
- Reorder groups by dragging their headers or using Move up and Move down in
  the group actions menu.
- Collapse or expand a group from its header and remember the choice locally.
- Load pins, groups, and hidden-project preferences before drawing project
  cards, and surface preference and action failures instead of silently
  ignoring them.
- Add keyboard reordering in Manual mode with Alt+Arrow Up or Alt+Arrow Down.
- Exclude archived chats from activity sparklines, validate stored project IDs,
  and serialize preference writes so simultaneous changes are not lost.
- Align development with Plugin SDK 0.4.47 and rebuild release archives from a
  clean output directory.

## 0.2.1 - 2026-09-02

- Fill the compact homepage layout (phones and narrow windows) with the
  launcher. BB reserved a short strip above the composer for its own
  recent-chats list, which left the top of the screen empty once that list was
  hidden.
- Show projects whose `bb.branding.icon` names a BB icon, such as `GridView`,
  with that glyph instead of the folder fallback.

## 0.2.0 - 2026-08-30

- Add Manual sorting with full-card drag and drop. Clicks still open projects,
  and drag affordances appear only after the gesture starts.
- Pin or unpin projects by dragging between the Pinned and All projects
  sections, while keeping the right-click actions available.
- Add right-click actions to rename and hide projects. Hidden projects can be
  restored from plugin settings.
- Highlight the project selected in the new-thread composer without changing
  the chosen sort order.
- Remove the ineffective current-project-priority setting and hover pin button.
- Refine card borders, sort focus behavior, project artwork sizing, and
  sparkline animation so it runs only on the first launcher mount.

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
