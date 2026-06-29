# Character Avatars

Drop your **10–11 character photos** in this folder. Players pick one for their
character on the setup screen; AI opponents are assigned the leftover photos at
random.

## How to add your photos

Name each file `avatar-01`, `avatar-02`, … through `avatar-15` and use any of
these formats (the game tries them in this order):

```
.png  .jpg  .jpeg  .webp
```

So `avatar-03.jpg`, `avatar-07.png`, etc. The numbered `.svg` placeholders
already in this folder are only fallbacks — once you add a real photo with the
same number, your photo is shown instead. You don't need to delete the
placeholders.

### Recommended

- **Square** images (e.g. 256×256 or larger) — they're displayed in a circle.
- Keep them reasonably small (under ~300 KB each) so the table loads fast.

## Want more, fewer, or differently-named photos?

Edit the list in [`../../src/avatars.js`](../../src/avatars.js):

- Change `AVATAR_COUNT` to add/remove slots.
- Change `AVATAR_EXTS` if you want to allow other file extensions.
- Change each avatar's `label` to give them in-game names.
