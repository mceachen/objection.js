'use strict';

const DeleteOperation = require('../../queryBuilder/operations/DeleteOperation');

class ManyToManyDeleteSqliteOperation extends DeleteOperation {

  constructor(name, opt) {
    super(name, opt);

    this.relation = opt.relation;
    this.owner = opt.owner;
  }

  onBeforeBuild(builder) {
    super.onBeforeBuild(builder);
    this.relation.selectForModifySqlite(builder, this.owner).modify(this.relation.modify);
  }
}

module.exports = ManyToManyDeleteSqliteOperation;
