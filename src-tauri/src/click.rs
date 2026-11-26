// Pure gesture recognition shared with the Windows mouse hook. A drag cannot
// become a click by returning to its starting point before release.
#[derive(Default)]
pub struct ClickTracker {
    press: Option<(f64, f64)>,
}

pub enum MouseAction {
    Down,
    Move,
    Up,
}

impl ClickTracker {
    pub fn update(
        &mut self,
        action: MouseAction,
        x: f64,
        y: f64,
        modifier: bool,
        allowed: bool,
        tolerance: f64,
    ) -> bool {
        if !allowed || !modifier {
            self.press = None;
            return false;
        }
        match action {
            MouseAction::Down => {
                self.press = Some((x, y));
                false
            }
            MouseAction::Move => {
                if self
                    .press
                    .is_some_and(|(a, b)| (x - a).hypot(y - b) > tolerance)
                {
                    self.press = None;
                }
                false
            }
            MouseAction::Up => self
                .press
                .take()
                .is_some_and(|(a, b)| (x - a).hypot(y - b) <= tolerance),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_modified_clicks_complete_and_dragging_stays_cancelled() {
        let mut tracker = ClickTracker::default();
        assert!(!tracker.update(MouseAction::Down, -100., 40., true, true, 5.));
        assert!(tracker.update(MouseAction::Up, -99., 40., true, true, 5.));
        tracker.update(MouseAction::Down, 0., 0., true, true, 5.);
        tracker.update(MouseAction::Move, 20., 0., true, true, 5.);
        assert!(!tracker.update(MouseAction::Up, 0., 0., true, true, 5.));
        for (modifier, allowed) in [(false, true), (true, false)] {
            tracker.update(MouseAction::Down, 0., 0., true, true, 5.);
            assert!(!tracker.update(MouseAction::Up, 0., 0., modifier, allowed, 5.));
        }
        assert!(!tracker.update(MouseAction::Up, 0., 0., true, true, 5.));
    }
}
