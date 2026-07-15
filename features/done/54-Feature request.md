# Feature Request: Customer Feature Requests Portal for RestHippo

Implement a complete feature request portal for RestHippo.

The implementation should feel like a polished SaaS feature portal similar to Canny or GitHub Discussions while using GitHub Issues as the authoritative backend.

## Overall Goals

Create a new `/features` section on RestHippo that:

* Requires GitHub authentication.
* Uses GitHub Issues in the `jfigge/resthippo` repository as the source of truth.
* Allows authenticated users to:

  * Browse feature requests.
  * Search existing requests.
  * Detect likely duplicates before submitting.
  * Create new feature requests.
  * Upvote requests using GitHub 👍 reactions.
  * Comment on requests.
  * Edit their own requests when permitted by GitHub.
  * Upload screenshots/images.
  * Subscribe for release notifications.
* Synchronizes automatically using GitHub webhooks.

The implementation should integrate naturally with the existing RestHippo website styling and architecture.

---

# Technology Requirements

Use:

* Native JavaScript
* Node.js
* GitHub REST API
* GitHub Webhooks

Avoid introducing large frameworks or unnecessary dependencies.

---

# Authentication

Require GitHub OAuth login.

Unauthenticated visitors may browse feature requests but must sign in with GitHub before:

* voting
* creating requests
* commenting
* editing
* subscribing

Persist GitHub access tokens securely.

---

# GitHub Repository

Repository:

jfigge/resthippo

Every approved feature request corresponds to a GitHub Issue.

Automatically apply the label:

feature-request

---

# Feature Request Page

Create:

/features

The page should include:

* Search bar
* Featured requests
* Sort selector
* Request list
* "Request Feature" button

Sorting options:

* Top Voted
* In Progress
* Released

Each request card should display:

* Title
* Description preview
* Vote count (GitHub 👍 reactions)
* Current status
* Author
* Creation date
* Number of comments
* Labels
* Screenshot thumbnail if available

---

# Status Mapping

Use GitHub labels.

| Label               | Display             |
| ------------------- | ------------------- |
| proposed            | Proposed            |
| under-consideration | Under Consideration |
| released            | Released            |
| closed              | Closed              |

Only one status label should be active.

---

# Searching

Implement fast searching.

Search:

* title
* body
* labels

Before allowing a new submission:

Search for similar issues.

Use fuzzy matching on:

* title
* keywords

If similar issues exist:

Display:

"These requests look similar."

Allow the user to:

* open existing request
* upvote it
* continue anyway

Require explicit confirmation before creating a duplicate.

---

# Creating Requests

Submission form:

Title

Description

Expected behavior

Current workaround (optional)

Screenshot upload

The screenshot should automatically upload into the GitHub issue using GitHub-supported image upload mechanisms (or create a temporary upload endpoint if necessary).

Create a GitHub issue.

Automatically add:

feature-request

---

# Voting

Voting uses GitHub reactions.

Use:

👍

Display:

current vote count

Clicking Vote:

* adds reaction
* clicking again removes reaction

Handle:

* already reacted
* rate limits
* authentication expiration

---

# Comments

Display GitHub comments.

Allow authenticated users to add comments.

Refresh automatically.

---

# Editing

Users may edit only issues they originally created.

If GitHub permissions prevent editing:

Provide a friendly explanation.

---

# Screenshots

Support:

PNG

JPEG

GIF

Display thumbnails.

Open full-size on click.

---

# Release Notifications

Allow users to subscribe.

When an issue gains the "released" label:

Automatically notify subscribers by email.

Maintain subscriber records locally.

---

# Synchronization

Implement GitHub webhooks.

Handle:

issues

issue_comment

label

edited

deleted

reopened

closed

reaction

Synchronize changes into the local cache.

Avoid excessive GitHub API usage.

---

# Local Cache

Maintain a lightweight cache for:

vote totals

issue metadata

search indexing

subscriptions

webhook synchronization state

GitHub remains the source of truth.

---

# Admin Features

Admins can:

Approve pending requests

Reject requests

Merge duplicates

When merging duplicates:

* close duplicate
* reference canonical issue
* preserve votes if possible
* explain where discussion continues

---

# Duplicate Detection

Implement fuzzy matching using:

title similarity

shared keywords

token overlap

Return likely duplicates before submission.

---

# User Experience

The interface should feel modern and polished.

Support:

desktop

tablet

mobile

Dark mode if RestHippo already supports it.

Use optimistic UI updates where appropriate.

Gracefully handle GitHub API failures.

---

# Performance

Cache GitHub responses.

Avoid unnecessary API calls.

Lazy load comments.

Paginate requests.

Search should feel instantaneous.

---

# Security

Validate every webhook signature.

Protect OAuth tokens.

Escape user content.

Rate-limit request creation.

Prevent spam.

---

# Testing

Implement automated tests for:

OAuth

Issue creation

Voting

Duplicate detection

Webhook synchronization

Status updates

Comment creation

Search

Subscriptions

Responsive UI

---

# Documentation

Create documentation covering:

Architecture

OAuth setup

GitHub App configuration

Webhook configuration

Environment variables

Deployment

Troubleshooting

---

# Deliverables

Provide:

1. Complete implementation
2. Database/cache schema
3. OAuth integration
4. GitHub REST client
5. Webhook handlers
6. Feature request UI
7. Search implementation
8. Duplicate detection
9. Voting
10. Comment support
11. Screenshot uploads
12. Release notification service
13. Admin tools
14. Automated tests
15. Documentation

Before making architectural changes, inspect the existing RestHippo codebase and reuse existing patterns whenever practical. Favor maintainability and minimal dependencies over introducing new frameworks.
