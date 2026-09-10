// Associate a verdict with the input version that produced it.
export class ValidationState {
  constructor() {
    this.sequence = 0;
    this.active = null;
  }
  invalidate() {
    this.sequence += 1;
    this.active = null;
  }
  begin() {
    this.active = ++this.sequence;
    return this.active;
  }
  isCurrent(request) {
    return this.active === request;
  }
  finish(request) {
    if (!this.isCurrent(request)) return false;
    this.active = null;
    return true;
  }
  get pending() {
    return this.active !== null;
  }
}
