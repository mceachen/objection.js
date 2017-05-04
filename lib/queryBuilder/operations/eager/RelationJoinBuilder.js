'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const ValidationError = require('../../../model/ValidationError');

const idLengthLimit = 63;
const relationRecursionLimit = 64;

class RelationJoinBuilder {

  constructor(args) {
    this.rootModelClass = args.modelClass;
    this.expression = args.expression;
    this.allRelations = null;

    this.pathInfo = Object.create(null);
    this.encodings = Object.create(null);
    this.decodings = Object.create(null);
    this.encIdx = 0;

    this.opt = _.defaults(args.opt, {
      minimize: false,
      separator: ':',
      aliases: {}
    });
  }

  clone(props) {
    props = props || {};

    const copy = new RelationJoinBuilder({
      modelClass: this.rootModelClass,
      expression: props.expression || this.expression,
      opt: props.opt || this.opt
    });

    copy.allRelations = this.allRelations;
    copy.pathInfo = this.pathInfo;
    copy.encodings = this.encodings;
    copy.decodings = this.decodings;
    copy.encIdx = this.encIdx;

    return copy;
  }

  /**
   * Fetches the column information needed for building the select clauses.
   * This must be called before calling `build`. `buildJoinOnly` can be called
   * without this since it doesn't build selects.
   */
  fetchColumnInfo(knex) {
    const columnInfo = RelationJoinBuilder.columnInfo;
    const allModelClasses = findAllModels(this.expression, this.rootModelClass);

    return Promise.all(allModelClasses.map(ModelClass => {
      const table = ModelClass.tableName;

      if (columnInfo[table]) {
        return columnInfo[table];
      } else {
        columnInfo[table] = knex(table).columnInfo().then(info => {
          const result = {
            columns: Object.keys(info)
          };

          columnInfo[table] = result;
          return result;
        });

        return columnInfo[table];
      }
    }));
  }

  buildJoinOnly(builder) {
    this.doBuild({
      expr: this.expression,
      builder: builder,
      modelClass: builder.modelClass(),
      joinOperation: this.opt.joinOperation || 'leftJoin',
      parentInfo: null,
      relation: null,
      noSelects: true,
      path: '',
    });
  }

  build(builder) {
    const builderClone = builder.clone();

    builder.table(`${this.rootModelClass.tableName} as ${this.rootModelClass.tableName}`);
    builder.findOptions({callAfterGetDeeply: true});

    this.doBuild({
      expr: this.expression,
      builder: builder,
      modelClass: builder.modelClass(),
      joinOperation: this.opt.joinOperation || 'leftJoin',
      parentInfo: null,
      relation: null,
      path: '',
      selectFilter: (col) => {
        return builderClone.hasSelection(col);
      }
    });
  }

  rowsToTree(rows) {
    if (_.isEmpty(rows)) {
      return rows;
    }

    const keyInfoByPath = this.createKeyInfo(rows);
    const pathInfo = _.values(this.pathInfo);

    const tree = Object.create(null);
    const stack = Object.create(null);

    for (let i = 0, lr = rows.length; i < lr; ++i) {
      const row = rows[i];
      let curBranch = tree;

      for (let j = 0, lp = pathInfo.length; j < lp; ++j) {
        const pInfo = pathInfo[j];
        const id = pInfo.idGetter(row);

        if (!id) {
          continue;
        }

        if (pInfo.relation) {
          const parentModel = stack[pInfo.encParentPath];

          curBranch = pInfo.getBranch(parentModel);

          if (!curBranch) {
            curBranch = pInfo.createBranch(parentModel);
          }
        }

        let model = pInfo.getModelFromBranch(curBranch, id);

        if (!model) {
          model = createModel(row, pInfo, keyInfoByPath);
          pInfo.setModelToBranch(curBranch, id, model);
        }

        stack[pInfo.encPath] = model;
      }
    }

    return this.finalize(pathInfo[0], _.values(tree));
  }

  createKeyInfo(rows) {
    const keys = Object.keys(rows[0]);
    const keyInfo = [];

    for (let i = 0, l = keys.length; i < l; ++i) {
      const key = keys[i];
      const sepIdx = key.lastIndexOf(this.sep);

      if (sepIdx === -1) {
        const pInfo = this.pathInfo[''];
        const col = key;

        if (!pInfo.omitCols[col]) {
          keyInfo.push({
            pInfo: pInfo,
            key: key,
            col: col
          });
        }
      } else {
        const encPath = key.substr(0, sepIdx);
        const path = this.decode(encPath);
        const col = key.substr(sepIdx + 1);
        const pInfo = this.pathInfo[path];

        if (!pInfo.omitCols[col]) {
          keyInfo.push({
            pInfo: pInfo,
            key: key,
            col: col
          });
        }
      }
    }

    return _.groupBy(keyInfo, kInfo => kInfo.pInfo.encPath);
  }

  finalize(pInfo, models) {
    const relNames = Object.keys(pInfo.children);

    if (Array.isArray(models)) {
      for (let m = 0, lm = models.length; m < lm; ++m) {
        this.finalizeOne(pInfo, relNames, models[m]);
      }
    } else if (models) {
      this.finalizeOne(pInfo, relNames, models);
    }

    return models;
  }

  finalizeOne(pInfo, relNames, model) {
    for (let r = 0, lr = relNames.length; r < lr; ++r) {
      const relName = relNames[r];
      const branch = model[relName];
      const childPathInfo = pInfo.children[relName];

      const finalized = childPathInfo.finalizeBranch(branch, model);
      this.finalize(childPathInfo, finalized);
    }
  }

  doBuild(args) {
    const expr = args.expr;
    const builder = args.builder;
    const selectFilter = args.selectFilter;
    const modelClass = args.modelClass;
    const relation = args.relation;
    const path = args.path;
    const parentInfo = args.parentInfo;
    const joinOperation = args.joinOperation;
    const noSelects = args.noSelects;

    if (!this.allRelations) {
      this.allRelations = findAllRelations(this.expression, this.rootModelClass);
    }

    const info = this.createPathInfo({
      modelClass: modelClass,
      path: path,
      relation: relation,
      parentInfo: parentInfo
    });

    this.pathInfo[path] = info;

    if (!noSelects) {
      this.buildSelects({
        builder: builder,
        selectFilter: selectFilter,
        modelClass: modelClass,
        relation: relation,
        info: info
      });
    }

    forEachExpr(expr, modelClass, (childExpr, relation) => {
      const nextPath = this.joinPath(path, relation.name);
      const encNextPath = this.encode(nextPath);
      const encJoinTablePath = relation.joinTable
        ? this.encode(joinTableForPath(nextPath))
        : null;

      const filterQuery = createFilterQuery({
        builder: builder,
        relation: relation,
        expr: childExpr
      });

      const relatedJoinSelectQuery = createRelatedJoinFromQuery({
        filterQuery: filterQuery,
        relation: relation,
        allRelations: this.allRelations
      });

      relation.join(builder, {
        joinOperation: joinOperation,
        ownerTable: info.encPath,
        relatedTableAlias: encNextPath,
        joinTableAlias: encJoinTablePath,
        relatedJoinSelectQuery: relatedJoinSelectQuery
      });

      // Apply relation.modify since it may also contains selections. Don't move this
      // to the createFilterQuery function because relatedJoinSelectQuery is cloned
      // From the return value of that function and we don't want relation.modify
      // to be called twice for it.
      filterQuery.modify(relation.modify);

      this.doBuild({
        expr: childExpr,
        builder: builder,
        modelClass: relation.relatedModelClass,
        joinOperation: joinOperation,
        relation: relation,
        parentInfo: info,
        noSelects: noSelects,
        path: nextPath,
        selectFilter: (col) => {
          return filterQuery.hasSelection(col);
        }
      });
    });
  }

  createPathInfo(args) {
    const modelClass = args.modelClass;
    const path = args.path;
    const relation = args.relation;
    const parentInfo = args.parentInfo;
    const encPath = this.encode(path);
    let info;

    if (relation && relation.isOneToOne()) {
      info = new OneToOnePathInfo();
    } else {
      info = new PathInfo();
    }

    info.path = path;
    info.encPath = encPath;
    info.parentPath = parentInfo && parentInfo.path;
    info.encParentPath = parentInfo && parentInfo.encPath;
    info.modelClass = modelClass;
    info.relation = relation;
    info.idGetter = this.createIdGetter(modelClass, encPath);

    if (parentInfo) {
      parentInfo.children[relation.name] = info;
    }

    return info;
  }

  buildSelects(args) {
    const builder = args.builder;
    const selectFilter = args.selectFilter;
    const modelClass = args.modelClass;
    const relation = args.relation;
    const info = args.info;
    const selects = [];
    const idCols = modelClass.getIdColumnArray();
    const rootTable = this.rootModelClass.tableName;

    RelationJoinBuilder.columnInfo[modelClass.tableName].columns.forEach(col => {
      const filterPassed = selectFilter(col);
      const isIdColumn = idCols.indexOf(col) !== -1;

      if (filterPassed || isIdColumn) {
        selects.push({
          col: `${info.encPath || rootTable}.${col}`,
          alias: this.joinPath(info.encPath, col)
        });

        if (!filterPassed) {
          info.omitCols[col] = true;
        }
      }
    });

    if (relation && relation.joinTableExtras) {
      const joinTable = this.encode(joinTableForPath(info.path));

      relation.joinTableExtras.forEach(extra => {
        if (selectFilter(extra.joinTableCol)) {
          selects.push({
            col: `${joinTable}.${extra.joinTableCol}`,
            alias: this.joinPath(info.encPath, extra.aliasCol)
          });
        }
      });
    }

    const tooLongAliases = selects.filter(select => select.alias.length > idLengthLimit);

    if (tooLongAliases.length) {
      throw new ValidationError({
        eager: `identifier ${tooLongAliases[0].alias} is over ${idLengthLimit} characters long `
        + `and would be truncated by the database engine.`
      });
    }

    builder.select(selects
      .filter(select => !builder.hasSelection(select.col, true))
      .map(select => `${select.col} as ${select.alias}`)
    );
  }

  encode(path) {
    if (!this.opt.minimize) {
      let encPath = this.encodings[path];

      if (!encPath) {
        const parts = path.split(this.sep);

        // Don't encode the root.
        if (!path) {
          encPath = path;
        } else {
          encPath = parts.map(part => this.opt.aliases[part] || part).join(this.sep);
        }

        this.encodings[path] = encPath;
        this.decodings[encPath] = path;
      }

      return encPath;
    } else {
      let encPath = this.encodings[path];

      if (!encPath) {
        // Don't encode the root.
        if (!path) {
          encPath = path;
        } else {
          encPath = this.nextEncodedPath();
        }

        this.encodings[path] = encPath;
        this.decodings[encPath] = path;
      }

      return encPath;
    }
  }

  decode(path) {
    return this.decodings[path];
  }

  nextEncodedPath() {
    return `_t${++this.encIdx}`;
  }

  createIdGetter(modelClass, path) {
    const idCols = modelClass.getIdColumnArray().map(col => this.joinPath(path, col));

    if (idCols.length === 1) {
      return createSingleIdGetter(idCols);
    } else if (idCols.length === 2) {
      return createTwoIdGetter(idCols);
    } else if (idCols.length === 3) {
      return createThreeIdGetter(idCols);
    } else {
      return createNIdGetter(idCols);
    }
  }

  get sep() {
    return this.opt.separator;
  }

  joinPath(path, nextPart) {
    if (path) {
      return `${path}${this.sep}${nextPart}`;
    } else {
      return nextPart;
    }
  }
}

function findAllModels(expr, modelClass) {
  const models = [];

  findAllModelsImpl(expr, modelClass, models);

  return _.uniqBy(models, 'tableName');
}

function findAllModelsImpl(expr, modelClass, models) {
  models.push(modelClass);

  forEachExpr(expr, modelClass, (childExpr, relation) => {
    findAllModelsImpl(childExpr, relation.relatedModelClass, models);
  });
}

function findAllRelations(expr, modelClass) {
  const relations = [];

  findAllRelationsImpl(expr, modelClass, relations);

  return _.uniqWith(relations, (lhs, rhs) => lhs === rhs);
}

function findAllRelationsImpl(expr, modelClass, relations) {
  forEachExpr(expr, modelClass, (childExpr, relation) => {
    relations.push(relation);

    findAllRelationsImpl(childExpr, relation.relatedModelClass, relations);
  });
}

function forEachExpr(expr, modelClass, callback) {
  const relations = modelClass.getRelationArray();

  if (expr.isAllRecursive() || expr.maxRecursionDepth() > relationRecursionLimit) {
    throw new ValidationError({
      eager: `recursion depth of eager expression ${expr.toString()} too big for JoinEagerAlgorithm`
    });
  }

  for (let i = 0, l = relations.length; i < l; ++i) {
    const relation = relations[i];
    const childExpr = expr.childExpression(relation.name);

    if (childExpr) {
      callback(childExpr, relation, relation.name);
    }
  }
}

function createSingleIdGetter(idCols) {
  const idCol = idCols[0];

  return (row) => {
    const val = row[idCol];

    if (!val) {
      return null;
    } else {
      return `id:${val}`;
    }
  };
}

function createTwoIdGetter(idCols) {
  const idCol1 = idCols[0];
  const idCol2 = idCols[1];

  return (row) => {
    const val1 = row[idCol1];
    const val2 = row[idCol2];

    if (!val1 || !val2) {
      return null;
    } else {
      return `id:${val1},${val2}`;
    }
  };
}

function createThreeIdGetter(idCols) {
  const idCol1 = idCols[0];
  const idCol2 = idCols[1];
  const idCol3 = idCols[2];

  return (row) => {
    const val1 = row[idCol1];
    const val2 = row[idCol2];
    const val3 = row[idCol3];

    if (!val1 || !val2 || !val3) {
      return null;
    } else {
      return `id:${val1},${val2},${val3}`;
    }
  };
}

function createNIdGetter(idCols) {
  return (row) => {
    let id = 'id:';

    for (let i = 0, l = idCols.length; i < l; ++i) {
      const val = row[idCols[i]];

      if (!val) {
        return null;
      }

      id += (i > 0 ? ',' : '') + val;
    }

    return id;
  };
}

function createFilterQuery(args) {
  const builder = args.builder;
  const expr = args.expr;
  const relation = args.relation;
  const filterQuery = relation.relatedModelClass
    .query()
    .childQueryOf(builder);

  for (let i = 0, l = expr.args.length; i < l; ++i) {
    const filterName = expr.args[i];
    const filter = expr.filters[filterName];

    if (typeof filter !== 'function') {
      throw new ValidationError({eager: `could not find filter "${filterName}" for relation "${relation.name}"`});
    }

    filter(filterQuery);
  }

  return filterQuery;
}

function createRelatedJoinFromQuery(args) {
  const filterQuery = args.filterQuery;
  const relation = args.relation;
  const allRelations = args.allRelations;
  const relatedJoinFromQuery = filterQuery.clone();

  const allForeignKeys = findAllForeignKeysForModel({
    modelClass: relation.relatedModelClass,
    allRelations
  });

  return relatedJoinFromQuery.select(allForeignKeys.filter(col => {
    return !relatedJoinFromQuery.hasSelection(col);
  }));
}

function findAllForeignKeysForModel(args) {
  const modelClass = args.modelClass;
  const allRelations = args.allRelations;
  const foreignKeys = modelClass.getIdColumnArray().slice();

  allRelations.forEach(rel => {
    if (rel.relatedModelClass.tableName === modelClass.tableName) {
      rel.relatedCol.forEach(col => foreignKeys.push(col));
    }

    if (rel.ownerModelClass.tableName === modelClass.tableName) {
      rel.ownerCol.forEach(col => foreignKeys.push(col));
    }
  });

  return _.uniq(foreignKeys);
}

function createModel(row, pInfo, keyInfoByPath) {
  const keyInfo = keyInfoByPath[pInfo.encPath];
  const json = {};

  for (let k = 0, lk = keyInfo.length; k < lk; ++k) {
    const kInfo = keyInfo[k];
    json[kInfo.col] = row[kInfo.key];
  }

  return pInfo.modelClass.fromDatabaseJson(json);
}

function joinTableForPath(path) {
  return path + '_join';
}

class PathInfo {

  constructor() {
    this.path = null;
    this.encPath = null;
    this.encParentPath = null;
    this.modelClass = null;
    this.relation = null;
    this.omitCols = Object.create(null);
    this.children = Object.create(null);
    this.idGetter = null;
  }

  createBranch(parentModel) {
    const branch = Object.create(null);
    parentModel[this.relation.name] = branch;
    return branch;
  }

  getBranch(parentModel) {
    return parentModel[this.relation.name];
  }

  getModelFromBranch(branch, id) {
    return branch[id];
  }

  setModelToBranch(branch, id, model) {
    branch[id] = model;
  }

  finalizeBranch(branch, parentModel) {
    const relModels = _.values(branch);
    parentModel[this.relation.name] = relModels;
    return relModels;
  }
}

class OneToOnePathInfo extends PathInfo {

  createBranch(parentModel) {
    return parentModel;
  }

  getBranch(parentModel) {
    return parentModel;
  }

  getModelFromBranch(branch, id) {
    return branch[this.relation.name];
  }

  setModelToBranch(branch, id, model) {
    branch[this.relation.name] = model;
  }


  finalizeBranch(branch, parentModel) {
    parentModel[this.relation.name] = branch || null;
    return branch || null;
  }
}

RelationJoinBuilder.columnInfo = Object.create(null);

module.exports = RelationJoinBuilder;
