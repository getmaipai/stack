# Reference clip sheet route

Object and place only reference clips are wired through the generic Stack make route. The Stack composes attached object and place pictures using the Ingredients sheet layout from the Max clip pack, then sends that PNG as multipart through the existing Ingredients endpoint, Max admission and receipt path. The receipt route is `reference_clip`, with a reason that says the sheet was composed from attached pictures. The pack's `max_places` cap applies to attached place pictures; composed views of one place use a grid.

Generated extra angles are not used by the reference clip yet. A real model run has not been made and is parked.
