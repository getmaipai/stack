---
title: Uninstall Stack
description: Remove the app and service while choosing what happens to your data.
---

1. Open the menu-bar **MaiPai Stack** icon.
2. Choose **Uninstall the Stack**.
3. Choose **Keep my data** or **Remove my data**.
4. Confirm.

**Keep my data** leaves your models, settings, keys, and chats for a later install. **Remove my data** removes those local files too.

To remove Stack from Terminal while keeping your data, paste:

```bash
curl -fsSL https://getmaipai.github.io/stack/install.sh | sh -s -- --uninstall
```

Do not add `--remove-data` unless you want to remove local data too.

Still need help? Open [Fix a problem](./fix-a-problem/).
