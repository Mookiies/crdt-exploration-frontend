export function unwrappedPromise(): [Promise<void>, () => void, () => void] {
    let resolver: unknown;
    let rejector: unknown;
    const promise = new Promise<void>((resolve, reject) => {
        resolver = resolve;
        rejector = reject;
    });
    return [promise, resolver as () => void, rejector as () => void];
}
