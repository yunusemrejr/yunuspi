# Migration regression fixtures

These old transforms are retained only for synthetic regression tests of the fork migration. The installer, updater, verifier and core build never import or run them. Core behavior is owned directly under core/*/src. New core changes must edit and test source, not add transforms.
