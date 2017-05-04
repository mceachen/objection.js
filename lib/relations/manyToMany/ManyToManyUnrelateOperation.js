'use strict';

const _ = require('lodash');
const QueryBuilderOperation = require('../../queryBuilder/operations/QueryBuilderOperation');

class ManyToManyUnrelateOperation extends QueryBuilderOperation {

  constructor(name, opt) {
    super(name, opt);

    this.isWriteOperation = true;
    this.relation = opt.relation;
    this.owner = opt.owner;
  }

  queryExecutor(builder) {
    let selectRelatedColQuery = this.relation.relatedModelClass
      .query()
      .childQueryOf(builder)
      .copyFrom(builder, /where/i)
      .select(this.relation.fullRelatedCol())
      .modify(this.relation.modify);

    return this.relation.joinTableModelClass(builder.knex())
      .query()
      .childQueryOf(builder)
      .delete()
      .whereComposite(this.relation.fullJoinTableOwnerCol(), this.owner.$values(this.relation.ownerProp))
      .whereInComposite(this.relation.fullJoinTableRelatedCol(), selectRelatedColQuery);
  }
}

module.exports = ManyToManyUnrelateOperation;