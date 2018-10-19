const path = require('path');
const Utils = require('@lushijie/utils');
const Parser = require('../parser');
const Generator = require('../generator');
const Thriftrw = require('thriftrw').Thrift;
const ALL_THRIFT_TYPE = require('../constants/type');
const Icon = require('../constants/icon');

module.exports = class ThriftTool {
  constructor() {
    // 解析数据都存在这里，解析也是操作引用读取
    this.store = this._createStore();

    this.result = {};
  }

  // 创建存储空间
  _createStore() {
    const store = {};
    ALL_THRIFT_TYPE.forEach(type => {
      store[type] = {};
    });
    return store;
  }

  // 根据类型设置存储，
  _setStoreByType(type, payload) {
    this.store[type] = Utils.extend(this.store[type], payload);
  }

  // 获取存储空间
  getStore() {
    return this.store;
  }

  // 获取第N步的解析结果
  getResult(step) {
    if (!step) {
      return this.result;
    }
    return this.result[step];
  }

  // 解析
  parse(filePath, name) {
    let DEFINITIONS;
    try {
      const thriftrw = new Thriftrw({
        // source: filePath,
        strict: false,
        entryPoint: path.resolve(filePath),
        allowFilesystemAccess: true,
        allowOptionalArguments: true,
        defaultAsUndefined: false,
      }).toJSON();

      const ENTRY_POINT = thriftrw.entryPoint;
      DEFINITIONS = thriftrw['asts'][ENTRY_POINT]['definitions'];
      if(!DEFINITIONS) {
        throw new Error(`解析结果为空: ${JSON.stringify(thriftrw)}`);
      }
      this.result[1] = DEFINITIONS;
      // console.log('--- 第一次解析 thriftrw 结果 ---');
      // console.log(JSON.stringify(this.result[1]));
    } catch(e) {
      throw new Error(`语法错误，生成AST失败：${e}`);
    }

    DEFINITIONS.forEach(ele => {
      const type = ele.type.toLowerCase();
      const fn = Parser[type];
      if (Utils.isFunction(fn)) {
          this._setStoreByType(type, fn(ele, this));
      } else {
        throw new Error(`${type} 类型解析器不存在`);
      }
    });
    this.result[2] = Utils.extend({}, this.getStore());
    // console.log('--- 第二次解析 ast转化 结果 ---');
    // console.log(JSON.stringify(this.result[2]), undefined, 2))

    const gen = this.createJSON();
    this.resolveDefUnion(gen);
    this.result[3] = Utils.extend({}, this.getStore());
    // console.log('--- 第三次解析 resolveDefUnion 结果 ---');
    // console.log(JSON.stringify(this.result[3], undefined, 2));

    // 不传具体获取的结构名时处理
    if (!name) {
      let ALL = {};
      ALL_THRIFT_TYPE.forEach(type => {
        ALL[type] = ALL[type] || {};
        Object.keys(this.getStore()[type]).forEach(key => {
          if (key) {
            ALL[type][key] = gen(key)
          }
        })
      });
      return ALL;
    }

    return gen(name);
  }

  // 创建JSON格式的factor
  createJSON() {
    const store = this.getStore();
    const self = this;
    return function gen(name) {
      const type = self.findThriftType(name);
      if (type) {
        const fn = Generator[type];
        if (Utils.isFunction(fn)) {
          return fn({
            name,
            syntax: store[type][name],
            gen,
          });
        }
        throw new Error(`${type} 类型构造器不存在`);
      }
      throw new Error(`${name} 未在 thrift 定义中找到`);
    }
  }

  // 查找 thrift 类型
  findThriftType(name) {
    const store = this.getStore();
    let matchedType = null;
    ALL_THRIFT_TYPE.forEach(type => {
      if (store[type][name] && !matchedType) {
        matchedType = type;
      }
    });
    return matchedType;
  }

  // 嵌套 type 的解析
  resolveMixType(valueType) {
    const valueStyle = valueType.type.toLowerCase();
    if (valueStyle === 'basetype') {
      return {
        valueStyle,
        valueType: valueType.baseType
      };
    }

    if (valueStyle === 'identifier') {
      return {
        valueStyle,
        valueType: valueType.name
      }
    }

    if (valueStyle === 'set' || valueStyle === 'list') {
      return {
        valueStyle,
        valueType: this.resolveMixType(valueType.valueType)
      }
    }

    if (valueStyle === 'map') {
      return {
        valueStyle,
        keyType: this.resolveMixType(valueType.keyType),
        valueType: this.resolveMixType(valueType.valueType)
      }
    }
  }

  // 嵌套 value 的解析
  resolveMixValue(value, prefix = 'const') {
    const valueType = value.type.toLowerCase();
    if (valueType === 'literal') {
      return value.value;
    }

    if (valueType === `${prefix}list` || valueType === `${prefix}set`) {
      return value.values.map(ele => {
        return this.resolveMixValue(ele);
      });
    }

    if (valueType === `${prefix}map`) {
      return value.entries.map(ele => {
        return {
          [ele.key.value]: this.resolveMixValue(ele.value)
        }
      });
    }
  }

  // store 中 typedef union 基本类型解析替换
  _replaceDefUnionType(gen) {
    const store = this.getStore();

    const fn = function(obj) {
      Object.keys(obj).map(key => {
        obj[key] = Generator['struct']({
          syntax: {
            [key]: obj[key]
          },
          gen
        })[key];
      });
    }

    // typedef
    const theDef = store['typedef'];
    fn(theDef);

    // union
    const theUnion = store['union'];
    Object.keys(theUnion).map(name => {
      fn(theUnion[name]);
    });
  }

  // 特定类型中的 union、typedef 的替换
  resolveDefUnion(gen) {
    this._replaceDefUnionType(gen);
    const store = this.getStore();

    const replaceType= ['exception', 'struct', 'service'];
    replaceType.forEach(type => {
      const self = this;

      function fn(obj) {
        if (!Utils.isObject(obj)) return;
        Object.keys(obj).forEach(key => {
          let ele = obj[key];

          // ele 兼容 service baseService: null 的情况
          if (ele && ele.valueStyle === 'identifier') {
            const type = self.findThriftType(ele.valueType);

            // typedef
            if (type === 'typedef') {
              ele = Utils.extend(ele, store['typedef'][ele.valueType]);
            }

            // union
            if (type === 'union') {
              // union 嵌套处理
              if (ele && Utils.isObject(ele)) {
                return fn(ele);
              }
              const theUnion = store['union'][ele.valueType]
              ele = Utils.extend(ele, {
                valueStyle: 'union',
                valueType: Object.keys(theUnion).map(key => {
                  if (!Utils.isString(theUnion[key])) {
                    return JSON.stringify(theUnion[key]);
                  }
                  return theUnion[key]
                }).join(Icon['or']),
              });
            }
          }
        });
      };

      let preobj = store[type];
      if (type === 'service') {
        // service 处理
        Object.keys(preobj).forEach(serviceName => {
          let preobj1 = preobj[serviceName];
          Object.keys(preobj1).forEach(key => {
            let preobj2 = preobj1['service'];
            Object.keys(preobj2).forEach(methodName => {
              let preobj3 = preobj2[methodName];
              fn(preobj3['returns']);
              fn(preobj3['arguments']);
              fn(preobj3['throws']);
            });
          });
        });
      } else {
        // struct/exception 同等处理
        Object.keys(preobj).forEach(ele => {
          fn(preobj[ele]);
        });
      }
    });
  }
}