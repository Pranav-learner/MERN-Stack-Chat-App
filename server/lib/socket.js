let _io = null;

export const setIO = (serverIo) => {
  _io = serverIo;
};

export const getIO = () => _io;

export const io = new Proxy({}, {
  get(target, prop) {
    if (prop === "instance") return _io;
    if (!_io) {
      if (prop === "to" || prop === "in") {
        return () => ({ emit: () => {} });
      }
      return () => {};
    }
    const val = _io[prop];
    return typeof val === "function" ? val.bind(_io) : val;
  },
});
