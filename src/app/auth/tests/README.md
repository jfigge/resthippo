# wurl Mock Server

A **mock response** from the wurl test server.

## Supported MIME types

- `application/json`
- `application/yaml`
- `application/xml`
- `text/html`
- `text/css`
- `text/markdown`

## Example

```js
fetch('http://localhost:8888/mimes/text/markdown')
  .then(r => r.text())
  .then(console.log);
```

> See the [/mimes](http://localhost:8888/mimes) endpoint for the full list.

| Code | Meaning |
| ---- | ------- |
| 200  | OK      |
| 404  | Not Found |