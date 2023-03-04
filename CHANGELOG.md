# Change Log


## [Unreleased]
### Changed
- The suggestion panel won't reopen if it was closed before the model returns a result.

## [0.3.7] - 2023-02-20
### Changed
- Swtiched gutter icons from SVG to PNG.

## [0.3.6] - 2023-02-16
### Added
- Added request timeout setting.

## [0.3.5] - 2023-02-12
### Added
- Show changed lines with background colors in the suggestion panel.
- Preview the target line region before getting model results.
- Improve svg icon aesthetics.
### Fixed
- The panel now only shows up when the target line region has been established.

## [0.3.3] - 2023-02-09
- Update readme.
### Fixed
- Preserve editor focus when suggesting edits. (This works better for an interactive setting where the user can make additional edits to prompt the model.)
### Added
- Clear the target line region when the suggestion panel becomes not visible.

## [0.3.0] - 2023-02-07
### Changed
- Replace the old command with `Coeditor: Suggest edits for selection` and `Coeditor: Suggest edits`.
### Added
- Add visual indication of the target line region.

## [0.2.4]
### Fixed
- Fix setting paths. 
### Added 
- Add option to write logs directly to the target project.

## [0.2.3]
### Changed
- Staged changes are now treated as part of the last commit.

## [0.2.2]
### Added
- The extension now tracks which suggestion has already been applied so the user can directly click another suggestion without having to undo the previously applied one.

## [0.0.2]
- Initial release.